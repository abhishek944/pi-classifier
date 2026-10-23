import { ClassifierError, isRecord, type ImageReference, type PreparedImage, type Question } from "./types.js";

export function isImageReference(value: unknown): value is ImageReference {
  return isRecord(value) && Object.hasOwn(value, "$image");
}

/** Only explicit reference objects are special; provider-native-looking user JSON stays data. */
export function imageReferences(value: unknown): string[] {
  if (isImageReference(value)) return [value.$image];
  if (Array.isArray(value)) return value.flatMap(imageReferences);
  if (isRecord(value)) return Object.values(value).flatMap(imageReferences);
  return [];
}

export function questionImageReferences(questions: Record<string, Question>): string[] {
  return Object.values(questions).flatMap((question) => [
    ...imageReferences(question.instructions),
    ...("criteria" in question && question.criteria ? Object.values(question.criteria).flatMap(imageReferences) : []),
  ]);
}

export function mapImageReferences(value: unknown, image: (id: string) => unknown): unknown {
  if (isImageReference(value)) return image(value.$image);
  if (Array.isArray(value)) return value.map((entry) => mapImageReferences(entry, image));
  if (isRecord(value)) return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mapImageReferences(entry, image)]),
  );
  return value;
}

export function namedImage(images: PreparedImage[], id: string): PreparedImage {
  const image = images.find((entry) => entry.id === id);
  if (!image) throw new ClassifierError("input", "Unknown named image reference.");
  return image;
}

export function imageUrl(image: PreparedImage): string {
  return "url" in image ? image.url : "data:" + image.mimeType + ";base64," + image.data;
}

/** Preserve JSON punctuation as text, interleaving only explicitly referenced images.
 * Raw user objects never become provider-native content parts.
 */
export function imageContentParts(
  value: unknown,
  image: (id: string) => unknown,
): unknown[] {
  const parts: unknown[] = [];
  let text = "";
  const flush = () => { if (text) { parts.push(text); text = ""; } };
  const visit = (entry: unknown): void => {
    if (isImageReference(entry)) { flush(); parts.push(image(entry.$image)); }
    else if (Array.isArray(entry)) {
      text += "[";
      entry.forEach((child, i) => { if (i) text += ","; visit(child); });
      text += "]";
    } else if (isRecord(entry)) {
      text += "{";
      Object.entries(entry).forEach(([key, child], i) => {
        if (i) text += ",";
        text += JSON.stringify(key) + ":";
        visit(child);
      });
      text += "}";
    } else text += JSON.stringify(entry);
  };
  // Ordered content arrays are convenient for instructions and simple multimodal state.
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string" || isImageReference(entry))) {
    for (const entry of value) {
      if (typeof entry === "string") text += entry;
      else { flush(); parts.push(image(entry.$image)); }
    }
  } else if (typeof value === "string") text = value;
  else visit(value);
  flush();
  return parts;
}
