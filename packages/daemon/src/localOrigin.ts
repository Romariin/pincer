// Browsers do not apply CORS to WebSocket upgrades, so without this check any
// web page (or a DNS-rebound origin) could connect and drive a Harness that
// edits local files. Non-browser clients send no Origin header and are local
// by virtue of the 127.0.0.1 bind.
const LOCAL_ORIGIN_RE =
	/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.localhost)(:\d+)?$/i;

export function isLocalOrigin(origin: string | null): boolean {
	return origin === null || LOCAL_ORIGIN_RE.test(origin);
}
