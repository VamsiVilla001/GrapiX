# gx-contracts

Core types shared by all four planes. Source of truth for the generated
TypeScript (invariant 22).

Nothing here may reference a transport, a runtime or a product. If a type
cannot be described without saying "socket" or "Editor", it belongs in a plane
package or a product, not here.
