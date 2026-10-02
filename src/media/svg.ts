// Only static SVG elements are accepted. CSS, animation, declarations and
// encoded attribute values need a full XML/CSS sanitizer and are rejected.
const STATIC_ELEMENTS = new Set([
  "svg", "g", "defs", "desc", "title", "metadata", "a", "path", "rect",
  "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan",
  "textpath", "use", "symbol", "image", "lineargradient", "radialgradient",
  "stop", "clippath", "mask", "pattern", "marker", "filter", "feblend",
  "fecolormatrix", "fecomponenttransfer", "fecomposite", "feconvolvematrix",
  "fediffuselighting", "fedisplacementmap", "fedistantlight", "fedropshadow",
  "feflood", "fefunca", "fefuncb", "fefuncg", "fefuncr", "fegaussianblur",
  "feimage", "femerge", "femergenode", "femorphology", "feoffset",
  "fepointlight", "fespecularlighting", "fespotlight", "fetile", "feturbulence",
]);
const FRAGMENT = /^#[a-z_][\w:.-]*$/i;

export function isSafeStaticSvg(text: string): boolean {
  const document = text.replace(/^\s*<\?xml\s[^?]*\?>/, "").trim();
  if (!/^<svg(?:\s|\/?>)/i.test(document) || /<!|<\?|[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(document)) return false;
  const tags = document.match(/<(?:[^<>"']|"[^"<]*"|'[^'<]*')*>/g) ?? [];
  // Reject markup that the conservative tag tokenizer cannot account for.
  if (document.replace(/<(?:[^<>"']|"[^"<]*"|'[^'<]*')*>/g, "").includes("<")) return false;
  for (const tag of tags) {
    const match = /^<\/?([a-z_][\w:.-]*)([\s\S]*?)\/?\s*>$/i.exec(tag);
    if (!match || !STATIC_ELEMENTS.has(match[1].split(":").pop()!.toLowerCase())) return false;
    let attributes = match[2];
    if (tag.startsWith("</") && attributes.trim()) return false;
    while (attributes.trim()) {
      const attribute = /^\s+([a-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
      if (!attribute) return false;
      const name = attribute[1].split(":").pop()!.toLowerCase();
      const value = attribute[2] ?? attribute[3];
      if (name.startsWith("on") || name === "style" || name === "base" || /[&\\@]/.test(value)) return false;
      if ((name === "href" || name === "src") && !FRAGMENT.test(value)) return false;
      // Presentation attributes may reference local gradients/filters only.
      if (/url\s*\(/i.test(value) && !/^url\(\s*['"]?#[a-z_][\w:.-]*['"]?\s*\)$/i.test(value)) return false;
      attributes = attributes.slice(attribute[0].length);
    }
  }
  return tags.length > 0;
}
