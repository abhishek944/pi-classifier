import {
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  renderClassifierBox,
  type ClassifierBoxMode,
  type ClassifierBoxPixelBox,
} from "./box.js";
import {
  CLASSIFIER_BOX_TOOL,
  CLASSIFIER_BOX_TOOL_DESCRIPTION,
  boxOutput,
  boxParameters,
} from "./tool-contracts.js";
import { ClassifierError, userError } from "./types.js";

// Re-exported so existing deep imports from "./box-tool.js" keep working.
export { boxOutput, boxParameters };

// Box parameters and result schemas are shared with the native Durable factory
// through ./tool-contracts.js so the two surfaces cannot drift.

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
      name: CLASSIFIER_BOX_TOOL,
      label: "Box image",
      description: CLASSIFIER_BOX_TOOL_DESCRIPTION,
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
