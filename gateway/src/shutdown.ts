// Closing is not logging out: planned restarts and redeploys must keep the credentials. Only an
// owner's disconnect or new pairing, or a session Orderly retired, logs out, which removes this
// linked device from the restaurant's phone, so stored credentials and backups of them stop
// working. Best effort and bounded: without a working connection the socket is simply closed and
// the owner is still asked to remove the device under Linked devices.
export const LOGOUT_TIMEOUT_MS = 3500;
// A session with no running worker (parked or crashed) is signed in by a short-lived worker only
// to be logged out (Supervisor.stopChild): it waits this long for WhatsApp to open the session,
// then up to LOGOUT_TIMEOUT_MS for the logout. The supervisor ends that worker after
// PARKED_LOGOUT_MS whatever happens, well inside the 20 s the backend waits for a disconnect.
export const PARKED_LOGOUT_CONNECT_MS = 7000;
export const PARKED_LOGOUT_MS = 12000;
// Only a device that finished pairing can be logged out. An unfinished phone-code pairing holds
// just the restaurant's own number, which a logout would name as the device to remove.
export function logsOut(requested: boolean, creds?: { account?: unknown } | null): boolean {
  return requested && !!creds?.account;
}
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
