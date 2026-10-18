// Closing is not logging out: planned restarts and redeploys must keep the credentials. Only an
// owner's disconnect or new pairing logs out, which removes this linked device from the
// restaurant's phone, so stored credentials and backups of them stop working. Best effort and
// bounded: without a working connection the socket is simply closed and the owner is still
// asked to remove the device under Linked devices.
export const LOGOUT_TIMEOUT_MS = 3500;
export async function endSocket(
  socket: { logout(): Promise<void>; end(error: Error | undefined): void } | undefined,
  logout: boolean,
  timeoutMs = LOGOUT_TIMEOUT_MS,
): Promise<boolean> {
  if (!socket) return false;
  if (logout) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loggedOut = await Promise.race([
      socket.logout().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (loggedOut) return true;
  }
  socket.end(new Error('STOPPED'));
  return false;
}
