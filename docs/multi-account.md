# One install, several Recitbot accounts: recorder contract

The server treats every account a recorder is paired with as a separate device. Nothing on the server links the
pairings of one install together; the recorder keeps them apart.

## Pairing

- One install holds one `device_id` + `device_token` + `device_secret` per account. Each account is paired with that
  account's own pairing code (`POST /device/enroll`), and each pairing opens its own socket (`/device/ws`) with its
  own token. Commands on a socket are signed with that device's secret and carry that account's `account_id`.
- Pairing with account B's code creates (or, with B's own `device_token`, reuses) a device row on account B only. It
  never revokes, replaces or changes a device of another account, whatever name, platform, IP or token is sent.
- When pairing account B, send B's `device_token` (if the install already has one for B), never another account's.
  A token of another account is ignored for pairing (a new device is created on B).
- Each pairing takes one of its own account's device slots. Plan limits, the watermark and recording ownership all
  follow the account whose bot started the recording (its `account_id` in the signed `start` command).

## Uninstall command

Recorders that support several accounts announce `"multi_account"` in the `features` of their `hello` frame. Only they
receive `scope`:

```json
{
  "type": "uninstall",
  "recording_id": "<request id>",
  "max_seconds": 0, "mic": false, "nonce": 0, "exp": 0,
  "account_id": "<account>", "device_id": "<device>", "upload_token": "",
  "scope": "account",
  "mac": "<hex>"
}
```

- `scope: "account"` (the default): remove only this account's pairing (its device id, token and secret). If other
  accounts remain paired, Recitbot stays installed and keeps running for them. If none remain, remove Recitbot
  completely (app, startup item, data).
- `scope: "all"`: remove Recitbot from the computer completely, for every account. Sent only when the user explicitly
  asked for full removal.
- Signing: `scope` is a signed block appended after the existing blocks: `...|scope|account` or `...|scope|all`
  (canonical form in `worker/src/device-hub.ts` `canonicalCommand`). Recorders without `multi_account` get no
  `scope` field and no block, and remove themselves completely as before.

## Uninstall reply

```json
{ "type": "uninstall_ack", "request_id": "<recording_id of the command>", "accounts_remaining": 1 }
```

- `accounts_remaining`: integer >= 0, how many accounts are still paired on this install after the removal (0 after
  `scope: "all"`, or when the last account was removed). Optional for older recorders; the server then reports that
  Recitbot was removed from the computer.
- Ack before removing anything: the server waits up to 30 s, and the socket closes right after (4001 "device revoked").

## Full removal: telling the other accounts

When a removal of the whole install arrives on one account (`scope: "all"`, or `"account"` for the last account),
the recorder first acks it on that account's socket as above, then sends this over every OTHER account's socket,
unsolicited, with no `request_id`:

```json
{ "type": "uninstall_ack", "accounts_remaining": 0 }
```

- The server reads an `uninstall_ack` that answers no request it is waiting for on that socket (no `request_id`, or
  an unknown one) with `accounts_remaining: 0` as "this device removed itself". It revokes that socket's own device
  on that socket's own account with scope `"all"` (the token then gets `410 {"error": "device_revoked", "scope":
  "all"}`), and closes the socket with 4001 "device revoked". No other device row, of that account or any other, is
  touched.
- An unsolicited ack with `accounts_remaining` above 0, or without it, is ignored.
- Send it before removing the pairings, while each socket is still open; nothing needs to wait for a reply.

## Uninstall while offline

The server revokes the device at once either way. When the recorder next uses that account's token (socket or
pairing), it gets:

```
HTTP 410  {"error": "device_revoked", "scope": "account"}
```

`scope` is the one the uninstall was requested with (`"all"` for uninstalls from before scopes existed). The recorder
then applies it exactly like the live command: `"account"` drops only that account's pairing; `"all"` removes
Recitbot completely. A 410 for one account says nothing about the install's other accounts.
