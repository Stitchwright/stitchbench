import "server-only";
import bwipjs from "bwip-js/node";

/** A Code 128 barcode as an SVG string (scans on any USB/Bluetooth scanner or phone camera). */
export function barcodeSvg(text: string, height = 9) {
  try {
    return bwipjs.toSVG({ bcid: "code128", text, height, includetext: false, scale: 2, paddingwidth: 0, paddingheight: 0 });
  } catch {
    return null; // characters Code 128 can't carry
  }
}
