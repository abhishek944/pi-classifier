import {
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  renderClassifierBox,
  type ClassifierBoxMode,
  type ClassifierBoxPixelBox,
} from "./box.js";
import { ClassifierError, userError } from "./types.js";

export const boxParameters = Type.Object(
  {
    image: Type.String({
      minLength: 1,
      maxLength: 4096,
      description:
        "Local PNG, JPEG or WebP file inside cwd. No URLs, symlinks or inline base64.",
    }),
    box: Type.Object(
      {
        top: Type.Number({ minimum: 0, maximum: 1 }),
        bottom: Type.Number({ minimum: 0, maximum: 1 }),
        left: Type.Number({ minimum: 0, maximum: 1 }),
        right: Type.Number({ minimum: 0, maximum: 1 }),
      },
      {
        additionalProperties: false,
        description:
          "Normalized edges between 0 and 1, with top < bottom and left < right.",
      },
    ),
    mode: Type.Optional(
      Type.Union([Type.Literal("overlay"), Type.Literal("crop")], {
        description:
          "overlay draws the box on the image (default); crop returns only the boxed region.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const boxOutput = Type.Object({
  mode: Type.Union([Type.Literal("overlay"), Type.Literal("crop")]),
  mimeType: Type.Literal("image/png"),
  width: Type.Integer({ minimum: 1 }),
  height: Type.Integer({ minimum: 1 }),
  pixelBox: Type.Object({
    left: Type.Integer({ minimum: 0 }),
    top: Type.Integer({ minimum: 0 }),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
  }),
  byteLength: Type.Integer({ minimum: 1 }),
});

type BoxToolDetails = {
  mode: ClassifierBoxMode;
  mimeType: "image/png";
  width: number;
  height: number;
  pixelBox: ClassifierBoxPixelBox;
  byteLength: number;
};

export function registerBoxTool(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool<typeof boxParameters, BoxToolDetails>({
      name: "classifier_box_image",
      label: "Box image",
      description:
        "Render a normalized bounding box on a local image, or crop to it, entirely locally. Use to inspect a box answer from classify. overlay keeps the image and draws a rectangle; crop returns only the clamped region. Returns a PNG plus exact source-pixel box metadata. No provider request, upload, resizing or disk write. A box is a localization hint, not proof that the object exists.",
      promptSnippet:
        "Render or crop a local image using normalized box coordinates.",
      promptGuidelines: [
        "Use classifier_box_image only for local images inside cwd and normalized boxes between 0 and 1.",
        "A returned box does not by itself confirm that the object exists.",
      ],
      parameters: boxParameters,
      outputSchema: boxOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      async execute(_id, params, signal, _onUpdate, ctx) {
        try {
          const result = await renderClassifierBox(params, {
            cwd: ctx.cwd,
            ...(signal ? { signal } : {}),
          });
          const byteLength = Buffer.from(result.data, "base64").byteLength;
          const details: BoxToolDetails = {
            mode: result.mode,
            mimeType: result.mimeType,
            width: result.width,
            height: result.height,
            pixelBox: result.pixelBox,
            byteLength,
          };
          const box = result.pixelBox;
          return {
            content: [
              {
                type: "text",
                text:
                  "Rendered " +
                  result.mode +
                  " box as a " +
                  result.width +
                  "×" +
                  result.height +
                  " PNG (" +
                  byteLength +
                  " bytes). Source pixel box: left=" +
                  box.left +
                  ", top=" +
                  box.top +
                  ", width=" +
                  box.width +
                  ", height=" +
                  box.height +
                  ". A box is a localization hint, not proof that the object exists.",
              },
              {
                type: "image",
                data: result.data,
                mimeType: result.mimeType,
              },
            ],
            details,
            structuredContent: details,
          };
        } catch (error) {
          console.error(
            "[pi-classifier] box image failed: " +
              (error instanceof ClassifierError ? error.code : "unexpected"),
          );
          throw new Error(userError(error));
        }
      },
    }),
  );
}
