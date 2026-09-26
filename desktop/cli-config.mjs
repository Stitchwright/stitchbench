// The installed program's settings, for the maintenance scripts in this folder (run from the repo; not shipped).
// SB_FLAVOR=stitchshop picks StitchShop's. The database password is in secrets.json (in config.json before 1.5).
import fs from "node:fs";
import path from "node:path";

export const FLAVOR = process.env.SB_FLAVOR === "stitchshop" ? "stitchshop" : "stitchbench";

export function programConfig() {
  const dir = path.join(process.env.APPDATA, FLAVOR === "stitchshop" ? "StitchShop" : "StitchBench");
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
