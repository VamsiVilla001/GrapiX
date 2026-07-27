import {
  createSceneId,
  type AnimatableProperty,
  type PropertyChannelMap
} from "@grapix/shared-types";

export function clonePropertyAnimation(
  animation: PropertyChannelMap | undefined
): PropertyChannelMap | undefined {
  if (!animation) return undefined;

  const clone = structuredClone(animation);
  for (const channel of Object.values(clone)) {
    if (!channel) continue;
    channel.keys = channel.keys.map((key) => ({
      ...key,
      id: createSceneId("pkf")
    }));
  }
  return clone;
}

export function removePropertyKeyframe(
  animation: PropertyChannelMap | undefined,
  property: AnimatableProperty,
  keyframeId: string
): PropertyChannelMap | undefined {
  if (!animation?.[property]) return animation;

  const nextAnimation = { ...animation };
  const keys = animation[property].keys.filter((key) => key.id !== keyframeId);
  if (keys.length > 0) {
    nextAnimation[property] = { keys };
  } else {
    delete nextAnimation[property];
  }

  return Object.keys(nextAnimation).length > 0 ? nextAnimation : undefined;
}
