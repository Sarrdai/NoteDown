// Forwards an invitation link into the app. A classic script in the head (not a module, no defer), so the redirect
// happens before the page renders. The link's fragment (identity, secret, name) never reaches a server: the app takes
// it from the address. A file of its own because the page's Content-Security-Policy allows no inline script.
if (matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.dataset.flavor = "mocha";
addEventListener("DOMContentLoaded", () => { document.getElementById("open").href = "../" + location.hash; });
location.replace("../" + location.hash);
