import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalAddress } from "../app/js/core/local-address.js";

const all = (hosts, expected) => { for (const host of hosts) assert.equal(isLocalAddress(host), expected, JSON.stringify(host)); };

test("isLocalAddress: this computer", () => {
  all(["localhost", "127.0.0.1", "127.0.0.0", "127.1.2.3", "127.255.255.255", "[::1]"], true);
});

test("isLocalAddress: the private IPv4 ranges of the local network", () => {
  all(["10.0.0.0", "10.0.0.5", "10.255.255.255", "172.16.0.1", "172.20.1.1", "172.31.255.255", "192.168.0.1", "192.168.178.23", "192.168.255.255"], true);
});

test("isLocalAddress: the ranges end where they should", () => {
  all(["9.255.255.255", "11.0.0.0", "126.255.255.255", "128.0.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "192.0.0.1", "169.254.1.1", "100.64.0.1"], false);
});

test("isLocalAddress: a name that merely contains a local one is not local", () => {
  all(["localhost.example.com", "mylocalhost", "notlocalhost", "127.0.0.1.nip.io", "10.0.0.1.nip.io", "192.168.0.1.example.com", "127.0.0.1.", "localhost."], false);
});

test("isLocalAddress: the host of the deployed web app and other hosts are not local", () => {
  all(["", "example.com", "app.example.org", "sarrdai.github.io", "8.8.8.8", "1.1.1.1", "203.0.113.7", "[::2]", "[fe80::1]", "[2001:db8::1]", "::1"], false);
});

test("isLocalAddress: only addresses a browser would write count", () => {
  // "010.0.0.1" is octal for 8.0.0.1; a browser never writes it, so it is not guessed.
  all(["010.0.0.1", "10.00.0.1", "127.0.0.01", "10.0.0", "10.0.0.0.1", "10.0.0.256", "10.0.0.-1", "10.0.0.1 ", " 10.0.0.1", "10.0.0.1\n", "+10.0.0.1", "0x7f.0.0.1", "2130706433", "１０.0.0.1"], false);
});

test("isLocalAddress: no host name, no answer", () => {
  all([undefined, null, 127, {}], false);
});

test("isLocalAddress: on the host names a URL parser makes of odd spellings", () => {
  const host = url => new URL(url).hostname;
  all([host("http://LOCALHOST:8000/"), host("http://0x7f.1/"), host("http://2130706433/"), host("http://[0:0:0:0:0:0:0:1]:8000/"), host("http://0xa.1/")], true);
  all([host("http://010.0.0.1/"), host("http://127.0.0.1@example.com/"), host("http://example.com/127.0.0.1"), host("http://localhost.example.com/")], false);
});
