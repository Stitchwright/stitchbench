// The installed program's settings, for the maintenance scripts in this folder (run from the repo; not shipped).
// SB_FLAVOR=stitchshop picks StitchShop's. The database password is in secrets.json (in config.json before 1.5).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FLAVOR = process.env.SB_FLAVOR === "stitchshop" ? "stitchshop" : "stitchbench";

export function programConfig() {
  const name = FLAVOR === "stitchshop" ? "StitchShop" : "StitchBench";
  // Electron's userData folder: %APPDATA% on Windows, ~/Library/Application Support on macOS, ~/.config on Linux.
  const base =
    process.platform === "win32" ? process.env.APPDATA : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support") : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));
  const dir = path.join(base, name);
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8").replace(/^﻿/, ""));
    } catch (e) {
      if (e.code === "ENOENT") return {};
      throw e;
    }
  };
  return { ...read("config.json"), ...read("secrets.json") };
}
