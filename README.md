# pi-pinned-messages

Pinned messages for [pi](https://pi.dev).

## Install

```bash
pi install https://github.com/ryanmiville/pi-pinned-messages
```

Then restart pi or run `/reload`.

## Use

- `/pin [title]` pins the last assistant message.
- `Ctrl+Shift+P` pins the last assistant message.
- In `/tree`, `Shift+P` toggles a pin on the selected message.
- In `/tree`, `Ctrl+P` filters to pinned messages.
- In `/tree`, `Ctrl+V` previews the selected message.

Pins are stored as pi labels with a `📌` prefix, so they persist with the session and survive restarts/forks.
