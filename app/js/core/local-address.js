// Whether a host name is this computer or a device in the local network: where the prototype is developed. The
// URL switches that replace stored data or point the app at another server (`?sample`, `?api=`, …) work only there
// (PROJECT.md → "Prototype options (variants)", docs/security-review.md → M3). No DOM access.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Whether `hostname`, as `location.hostname` writes it (lower case, an IPv6 address in brackets), is `localhost`, an
 * address of this computer (127.0.0.0/8, `[::1]`) or a private IPv4 address of the local network (10/8, 172.16/12,
 * 192.168/16). A name that only contains one (`localhost.example.com`, `127.0.0.1.nip.io`) is not.
 */
export function isLocalAddress(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const m = typeof hostname === "string" ? IPV4.exec(hostname) : null;
  // Plain decimals only: a browser writes an address that way, and "010.0.0.1" would be octal for 8.0.0.1.
  if (!m || m.slice(1).some(octet => (octet.length > 1 && octet.startsWith("0")) || +octet > 255)) return false;
  const [a, b] = [+m[1], +m[2]];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
