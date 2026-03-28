/**
 * Addon store: list of Stremio addons with enable/disable.
 * Every change (add, update, delete) is persisted to backend/data/addons.json
 * so the server is the single source of truth (local dev or deployed).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../data");
const FILE = join(DATA_DIR, "addons.json");

function read() {
  if (!existsSync(FILE)) {
    return { addons: [], nextId: 1 };
  }
  try {
    const raw = readFileSync(FILE, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.addons)) data.addons = [];
    if (typeof data.nextId !== "number") data.nextId = Math.max(1, ...data.addons.map((a) => a.id)) + 1;
    return data;
  } catch {
    return { addons: [], nextId: 1 };
  }
}

function write(data) {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(FILE, JSON.stringify({ addons: data.addons, nextId: data.nextId }, null, 2), "utf8");
}

export function getAllAddons() {
  const { addons } = read();
  return addons.map((a) => ({
    id: a.id,
    baseUrl: a.baseUrl,
    name: a.name ?? null,
    enabled: Boolean(a.enabled),
  }));
}

export function getEnabledAddons() {
  return getAllAddons().filter((a) => a.enabled);
}

export function addAddon(baseUrl, name = null) {
  const base = baseUrl.replace(/\/?$/, "/");
  const data = read();
  if (data.addons.some((a) => a.baseUrl.replace(/\/?$/, "/") === base)) {
    return null; // duplicate
  }
  const id = data.nextId++;
  data.addons.push({ id, baseUrl: base, name, enabled: true });
  write(data);
  return { id, baseUrl: base, name, enabled: true };
}

export function updateAddon(id, { enabled, name }) {
  const data = read();
  const i = data.addons.findIndex((a) => a.id === id);
  if (i < 0) return null;
  if (enabled !== undefined) data.addons[i].enabled = Boolean(enabled);
  if (name !== undefined) data.addons[i].name = name;
  write(data);
  return {
    id: data.addons[i].id,
    baseUrl: data.addons[i].baseUrl,
    name: data.addons[i].name ?? null,
    enabled: Boolean(data.addons[i].enabled),
  };
}

export function deleteAddon(id) {
  const data = read();
  const before = data.addons.length;
  data.addons = data.addons.filter((a) => a.id !== id);
  if (data.addons.length === before) return false;
  write(data);
  return true;
}
