import crypto from "crypto";
import { readFile, rename, writeFile } from "fs/promises";
import { resolve } from "path";
import { fileURLToPath } from "url";

const SITE = "https://mkissa.to";
const API = "https://api.mkissa.net/api";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0";
const PROJECT_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

async function gf(url, extra = {}, signal) {
  return globalThis.fetch(url, { headers: { "User-Agent": UA, ...extra }, signal });
}
async function gf2(url, extra) {
  const r = await globalThis.fetch(url, { headers: { "User-Agent": UA, ...extra } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

function hexXor(a, b) {
  const ab = Buffer.from(a, "hex"), bb = Buffer.from(b, "hex"), o = Buffer.alloc(ab.length);
  for (let i = 0; i < ab.length; i++) o[i] = ab[i] ^ bb[i];
  return o.toString("hex");
}

function decryptApiResponse(encoded, key) {
  const payload = Buffer.from(encoded, "base64");
  if (payload.length < 29 || payload[0] !== 1) throw new Error("invalid encrypted API response");

  const iv = payload.subarray(1, 13);
  const tag = payload.subarray(-16);
  const ciphertext = payload.subarray(13, -16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function sourceUrls(response, key) {
  const parsed = JSON.parse(response);
  const encoded = parsed?.data?.episode?.sourceUrls || parsed?.data?.episode?.tobeparsed || parsed?.data?.tobeparsed || parsed?.tobeparsed;
  if (typeof encoded !== "string") throw new Error("API response did not include encrypted source URLs: " + JSON.stringify(parsed).slice(0, 500));

  const plain = decryptApiResponse(encoded, key);
  const urls = [...plain.matchAll(/"sourceUrl":"([^"\\]+(?:\\.[^"\\]*)*)"(?:,|})/g)]
    .map((match) => JSON.parse(`"${match[1]}"`))
    .filter((url) => /^(https?:\/\/|--)/.test(url));
  if (!urls.length) throw new Error("episode has no source URLs");
  return urls;
}

function decodeProviderId(value) {
  if (!value.startsWith("--")) return value;

  const pairs = [
    ["79", "A"], ["7a", "B"], ["7b", "C"], ["7c", "D"], ["7d", "E"], ["7e", "F"], ["7f", "G"], ["70", "H"], ["71", "I"], ["72", "J"], ["73", "K"], ["74", "L"], ["75", "M"], ["76", "N"], ["77", "O"], ["68", "P"], ["69", "Q"], ["6a", "R"], ["6b", "S"], ["6c", "T"], ["6d", "U"], ["6e", "V"], ["6f", "W"], ["60", "X"], ["61", "Y"], ["62", "Z"], ["63", "["], ["65", "]"], ["78", "@"], ["19", "!"], ["1c", "$"], ["1e", "&"], ["10", "("], ["11", ")"], ["12", "*"], ["13", "+"], ["03", ";"], ["05", "="], ["1d", "%"],
    ["59", "a"], ["5a", "b"], ["5b", "c"], ["5c", "d"], ["5d", "e"], ["5e", "f"], ["5f", "g"], ["50", "h"], ["51", "i"], ["52", "j"], ["53", "k"], ["54", "l"], ["55", "m"], ["56", "n"], ["57", "o"], ["48", "p"], ["49", "q"], ["4a", "r"], ["4b", "s"], ["4c", "t"], ["4d", "u"], ["4e", "v"], ["4f", "w"], ["40", "x"], ["41", "y"], ["42", "z"], ["67", "_"], ["08", "0"], ["09", "1"], ["0a", "2"], ["0b", "3"], ["0c", "4"], ["0d", "5"], ["0e", "6"], ["0f", "7"], ["00", "8"], ["01", "9"], ["15", "-"], ["16", "."], ["46", "~"], ["02", ":"], ["17", "/"], ["07", "?"], ["1b", "#"],
  ];
  const table = new Map(pairs);
  const decoded = value.slice(2).match(/../g)?.map((pair) => table.get(pair) ?? "").join("");
  if (!decoded) throw new Error("invalid Wix provider ID");
  return decoded.replace("/clock", "/clock.json");
}

function wixMediaUrls(response) {
  const parsed = JSON.parse(response);
  const urls = parsed.links?.map((entry) => entry.link).filter((url) => typeof url === "string") ?? [];
  const media = urls.flatMap((url) => {
    if (!url.includes("repackager.wixmp.com/")) return [];
    const base = url.replace("https://repackager.wixmp.com/", "https://").replace(/\.urlset\/.*$/, "");
    const qualities = [...url.matchAll(/,([0-9]+p),/g)].map((match) => match[1]);
    return qualities.map((quality) => base.replace(/,([0-9]+p),\/mp4/, `${quality}/mp4`));
  });
  if (!media.length) throw new Error("Wix response contained no media URLs");
  return media.sort((left, right) => Number.parseInt(right) - Number.parseInt(left));
}

async function verifyMediaUrl(url) {
  const response = await gf(url, { Range: "bytes=0-0", Referer: "https://youtu-chan.com" });
  const valid = [200, 206].includes(response.status) && response.headers.get("content-type")?.startsWith("video/");
  await response.body?.cancel();
  return valid;
}

async function updateAniCli(config) {
  const target = resolve(PROJECT_ROOT, "ani-cli");
  const original = await readFile(target, "utf8");
  const values = {
    allanime_api: new URL(config.api).origin,
    allanime_key: config.key,
    allanime_epoch: String(config.epoch),
    allanime_build_id: config.build_id,
    allanime_query_hash: config.query_hash,
  };
  let updated = original;
  for (const [name, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${name}="[^"]*"$`, "m");
    if (!pattern.test(updated)) throw new Error(`ani-cli is missing ${name}`);
    updated = updated.replace(pattern, `${name}="${value}"`);
  }
  if (updated === original) return false;

  const temporary = `${target}.update-${process.pid}`;
  await writeFile(temporary, updated, { mode: 0o755 });
  await rename(temporary, target);
  return true;
}

// Find template literal assigned to varName or containing contentAnchor
function findTpl(src, varName, contentAnchor) {
  let idx = varName ? src.indexOf(varName + "=") : -1;
  if (idx < 0 && contentAnchor) idx = src.lastIndexOf("`", src.indexOf(contentAnchor));
  if (idx < 0) return null;
  const bt = src.indexOf("`", idx);
  if (bt < 0) return null;
  const be = src.indexOf("`", bt + 1);
  if (be < 0) return null;
  return src.slice(bt, be + 1);
}

// Find varname=e=>e?`T`:`F` falsy branch
function findFalsy(src, varName) {
  const idx = src.indexOf(varName + "=e=>e?");
  if (idx < 0) return null;
  const r = src.slice(idx + varName.length + 5);
  const b1 = r.indexOf("`"), b2 = r.indexOf("`", b1 + 1);
  if (b1 < 0 || b2 < 0) return null;
  const cl = r.indexOf(":", b2);
  const b3 = r.indexOf("`", cl), b4 = r.indexOf("`", b3 + 1);
  if (b3 < 0 || b4 < 0) return null;
  return `(()=>${r.slice(b3, b4 + 1)})`;
}

// Find funcName=function(){return `TPL`}
function findFunc(src, funcName, contentAnchor) {
  let idx = funcName ? src.indexOf(funcName + "=function") : -1;
  if (idx < 0 && contentAnchor) {
    const ci = src.indexOf(contentAnchor);
    if (ci < 0) return null;
    idx = Math.max(0, src.lastIndexOf("=function", ci));
  }
  if (idx < 0) return null;
  const ri = src.indexOf("return", idx);
  if (ri < 0) return null;
  const bt = src.indexOf("`", ri), be = src.indexOf("`", bt + 1);
  if (bt < 0 || be <= bt) return null;
  return src.slice(bt, be + 1);
}

async function main() {
  console.log("1. Fetch", SITE);
  const html = await (await gf2(SITE)).text();

  const cr = html.match(/window\.__aaCrypto\s*=\s*({[^;]+})/);
  if (!cr) throw new Error("MISSING __aaCrypto");
  const { epoch, partB } = JSON.parse(cr[1]);
  if (!epoch || !partB) throw new Error("MISSING epoch/partB");
  console.log("   epoch:", epoch);

  const am = html.match(/import\("([^"]+\/entry\/app\.[^"]+\.js)"\)/);
  if (!am) throw new Error("MISSING app entry");
  const appUrl = am[1];
  const appJs = await (await gf2(appUrl)).text();

  const dm = appJs.match(/\.f=\[([^\]]+)\]/);
  if (!dm) throw new Error("MISSING dep map");
  const deps = dm[1].split(",").map(s => s.replace(/"/g, "").trim());

  // Find crypto chunk (contains client-crypto/v1/bootstrap)
  const chunkUrls = deps.filter(d => d.endsWith(".js") && d.includes("chunks/")).map(d => new URL(d, appUrl).href);
  const aborter = new AbortController();
  let js;
  try {
    js = await Promise.any(chunkUrls.map(async (url) => {
    const r = await gf(url, {}, aborter.signal);
    const text = await r.text();
    if (text.includes("client-crypto/v1/bootstrap") || text.includes('"queryHash"')) return text;
    throw new Error("not the crypto chunk");
    }));
  } finally {
    aborter.abort();
  }
  if (js) console.log("   chunk found");
  if (!js) throw new Error("MISSING crypto chunk");
  console.log("   size:", js.length);

  const mask = js.match(/\bBa\s*=\s*(?:\w+\([^)]+\)\s*!==\s*"string"\s*\?\s*)?"([a-f0-9]{64})"/);
  if (!mask) throw new Error("MISSING mask");
  console.log("   mask:", mask[1]);

  const kr = js.match(/\bln\s*=\s*"(\d+)"/);
  if (!kr) throw new Error("MISSING buildId");
  const buildId = kr[1];
  console.log("   buildId:", buildId);

  const key = hexXor(Buffer.from(partB, "base64").toString("hex"), mask[1]);
  console.log("   key:", key);

  console.log("\n2. Templates");

  // Find templates: by varName, fallback to content anchor
  const t = {};
  const searches = [
    { k: "pc", vn: null, ca: "englishName\nnativeName\nslugTime" },
    { k: "qt", vn: null, ca: 'tbObj {\n  u\n  sm\n  md\n  ts' },
    { k: "Ca", vn: null, ca: "lastEpisodeInfo\nlastEpisodeDate" },
  ];
  for (const s of searches) t[s.k] = findTpl(js, s.vn, s.ca);

  t.Or = findFalsy(js, "Or");
  if (!t.Or) {
    const oi = js.indexOf("# ranks:[Object]");
    if (oi >= 0) {
      const bt = js.lastIndexOf("`", oi);
      const be = js.indexOf("`", oi);
      if (bt >= 0 && be > bt) t.Or = `(()=>${js.slice(bt, be + 1)})`;
    }
  }
  if (!t.lO) t.lO = findFunc(js, null, "query(\n$showId: String!");

  const missing = Object.entries(t).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error("MISSING templates: " + missing.join(", "));
  console.log("   all ok");

  console.log("\n3. Hash");
  let queryHash;
  try {
    const fn = new Function([
      `const gc = ${t.pc};`,
      `const Bt = ${t.qt};`,
      `const Ca = ${t.Ca};`,
      `const Or = ${t.Or};`,
      `const lO = () => ${t.lO};`,
      `return lO();`,
    ].join("\n"));
    queryHash = crypto.createHash("sha256").update(fn()).digest("hex");
    console.log("   hash:", queryHash);
  } catch (e) {
    throw new Error("HASH FAILED: " + e.message);
  }

  console.log("\n4. API test");
  const ts = Math.floor(Date.now() / 300000) * 300000;
  const iv = crypto.createHash("sha256").update(`${epoch}:${buildId}:${queryHash}:${ts}`).digest().subarray(0, 12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const ct = Buffer.concat([
    c.update(JSON.stringify({ v: 1, ts, epoch, buildId, qh: queryHash }), "utf8"), c.final()
  ]);
  const aaReq = Buffer.concat([Buffer.from([1]), iv, ct, c.getAuthTag()]).toString("base64");

  // Test with a known anime that has episodes
  const vars = JSON.stringify({ showId: "cstcbG4EquLyDnAwN", translationType: "sub", episodeString: "1" });
  const ext = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: queryHash }, aaReq });
  const resp = await (await gf2(`${API}?${new URLSearchParams({ variables: vars, extensions: ext })}`, { Origin: SITE, "x-build-id": buildId })).text();
  if (!resp.includes("tobeparsed")) throw new Error("API FAILED: " + resp.substring(0, 100));
  const sources = sourceUrls(resp, key);
  const wixSource = sources.find((url) => url.startsWith("--"));
  if (!wixSource) throw new Error("test episode has no Wix source");
  const wixPath = decodeProviderId(wixSource);
  const wixResponse = await (await gf2(`https://allanime.day${wixPath}`, { Referer: SITE })).text();
  const candidates = wixMediaUrls(wixResponse);
  let mediaUrl;
  for (const candidate of candidates) {
    if (await verifyMediaUrl(candidate)) {
      mediaUrl = candidate;
      break;
    }
  }
  if (!mediaUrl) throw new Error("Wix source did not return a playable media URL");
  console.log("   media URL:", mediaUrl);

  const config = { api: API, key, epoch, build_id: buildId, query_hash: queryHash, origin: SITE };
  if (process.argv.includes("--check")) {
    console.log("   config check passed; ani-cli was not changed");
  } else {
    console.log(`   ani-cli ${await updateAniCli(config) ? "updated" : "already current"}`);
  }

  console.log("\n" + JSON.stringify(config, null, 2));
}

main().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
