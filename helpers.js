// helpers.js
import axios from 'axios';
import fetch from 'node-fetch';   // only if you’re using fetch() here

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export async function fetchWithRetry(url, options = {}, retries = 5, backoff = 500) {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    const ra = res.headers.get('retry‑after');
    const wait = ra
      ? parseInt(ra, 10) * 1000
      : backoff * 2 ** i;
    console.warn(`⚠️ 429 – retry #${i + 1} in ${wait}ms`);
    await sleep(wait);
  }
  throw new Error(`❌ Max retries exceeded for ${url}`);
}

export async function axiosGetWithRetry(url, config = {}, retries = 5, backoff = 500) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await axios.get(url, config);
    } catch (err) {
      if (err.response?.status !== 429 || i === retries) throw err;
      const ra = err.response.headers['retry‑after'];
      const wait = ra
        ? parseInt(ra, 10) * 1000
        : backoff * 2 ** i;
      console.warn(`⚠️ 429 on Axios – retry #${i + 1} in ${wait}ms`);
      await sleep(wait);
    }
  }
}
