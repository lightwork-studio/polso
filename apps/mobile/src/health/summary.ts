import type { Preview } from "./reader";

export function previewLabel(preview: Preview): string {
  switch (preview.status) {
    case "value":
      return preview.text;
    case "empty":
      return "No data";
    case "notPreviewed":
      return "Access requested";
    case "unavailable":
      return "Needs a newer iOS";
    case "error":
      return "Couldn't read";
  }
}

/** Counts for the screen's header. Types this iOS version doesn't have aren't requested. */
export function summarize(previews: ReadonlyMap<string, Preview>) {
  let requested = 0;
  let withData = 0;
  for (const preview of previews.values()) {
    if (preview.status === "unavailable") continue;
    requested++;
    if (preview.status === "value") withData++;
  }
  return { requested, withData };
}
