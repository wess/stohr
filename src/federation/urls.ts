import { checkUrl, type SafeUrlOpts, type UrlCheck } from "../util/safeurl/index.ts"

// every URL a peer hands us (introducer, peer_base_url, gossiped members)
// goes through here before we store it or connect to it. production wants
// public https only. FEDERATION_ALLOW_HTTP=true is for two dev instances
// pairing over plain http on loopback, which is why it also lifts the
// private-address check — there is no other way to reach a localhost peer.

export const allowInsecurePeers = (): boolean =>
  /^(1|true|yes)$/i.test((process.env.FEDERATION_ALLOW_HTTP ?? "").trim())

// redirects are never followed: a signed peer request only verifies against
// the path it was minted for, and a pairing POST has no business moving
export const peerUrlOpts = (): SafeUrlOpts => {
  const insecure = allowInsecurePeers()
  return { allowHttp: insecure, allowPrivate: insecure, maxRedirects: 0 }
}

export const checkPeerUrl = (raw: string): Promise<UrlCheck> => checkUrl(raw, peerUrlOpts())
