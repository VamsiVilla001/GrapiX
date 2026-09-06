import type { AeContainerLoadPayload } from "@grapix/render-protocol";
import type { EngineController } from "./engineController.js";

/** Connects the Playout-owned AE runtime to the selected engine profile. */
export async function attachAeContainerToEngine(
  engineController: EngineController,
  profileId: string,
  args: AeContainerLoadPayload
): Promise<void> {
  await engineController.attachAeContainer(profileId, args);
}
