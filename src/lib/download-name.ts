/** A stored file's name made safe for a quoted Content-Disposition filename: quotes, backslashes and line breaks become "_". */
export function headerFileName(name: string): string {
  return name.replace(/["\\\r\n]/g, "_");
}
