/**
 * Wake-on-query is a self-hosted-deployment feature: the Worker-owned container
 * (the `[[containers]]` binding) is started only for the one user named in
 * CONTAINER_OWNER_USER_ID. Every other user's SessionDO ignores the binding, so
 * they never cause a container to start (or cost anything).
 *
 * Fails closed: an unset or empty value means nobody's container is woken, even
 * if the binding is enabled.
 */
export function isContainerOwner(
  env: { CONTAINER_OWNER_USER_ID?: string },
  userId: string,
): boolean {
  const owner = env.CONTAINER_OWNER_USER_ID?.trim();
  return !!owner && owner === userId;
}
