# RossTalk: how it works and how it is built (notes, 23 Nov 2026)

Decision (user, 23 Nov 2026): GrapiX's remote control (row 6.7) is **TCP, UDP and HTTP of our own design**,
not RossTalk, because RossTalk is a vendor protocol. These notes explain RossTalk so that a compatible
adapter can be added beside our own three later, if wanted. They are written in our own words from public
Ross pages and a public Ross PDF (the PDF forbids copying its text), from one research pass. "Read" means
the page was read; "snippet" means only a search result was seen. Nothing here is legal advice.

## In one paragraph

RossTalk is a plain-text, one-line-per-command protocol that Ross uses across many products. XPression
listens for it over **TCP on port 7788** once a "RossTalk" entry is added in its hardware setup (under the
GPI boards, state enabled, TCP port 7788). A client opens a socket and sends one command per line ending in
carriage return and line feed. Commands are case sensitive and positional, with parts separated by colons
(for example `TAKE 5:0:7`). The commands work the sequencer (the take items), the framebuffers and their
layers, and simulated GPI inputs. Ross's published XPression pages document **no reply and no state
feedback**; the commands look fire-and-forget (a guess, not verified on a real XPression).

## On the wire

| Point | What the sources say | Sure? |
|---|---|---|
| Transport | TCP, port 7788 (Ross command PDF, part 4802DR-403-35, June 2026, XPression section; Ross help page for XPression communication) | Read |
| Other transports | Ross's openGear cards also take RossTalk over serial (RS-232, RS-422) and UDP. Nothing documents UDP or serial for XPression | Read; XPression is TCP only as far as published |
| Framing | every command ends in CR/LF; also what the Bitfocus Companion XPression module sends (MIT licence) | Read |
| Case | commands are case sensitive | Read |
| Reply or feedback | none documented for XPression. The Companion module reads the socket but does nothing with what arrives | Read; "fire and forget" is a guess |
| Several clients | not documented for XPression. For Ross switchers the sheets list "one client" and "many clients" servers, and say to use a separate port per connection for other devices | Read; XPression's policy unknown |
| Connection handling | not documented; Companion just reconnects | Read |
| Length | Ross's automation sheet says commands of up to 32 characters can be sent | Read |

## The XPression commands (public list)

Numbers are zero-based for framebuffers in RossTalk, so RossTalk 0 is XPression's framebuffer 1 (Ross says
so itself).

| Command | What it does |
|---|---|
| `CUE takeid:buffer:layer` | get an item ready for air on a layer, with no frame delay, without taking it (the layer may be negative) |
| `TAKE takeid:buffer:layer` | load an item to air; the sequencer focus does not move |
| `SWAP buffer` | take to air everything that is cued in that framebuffer; a bare `SWAP` is used by Companion for "all" |
| `SEQI takeid:layer` | load on that layer to the output set in the template; the focus moves to the item |
| `SEQO takeid` | take the item off air |
| `READ` | take the current selection to air |
| `NEXT` | take the current item to air and move the selection on |
| `UP`, `DOWN` | move the selection |
| `FOCUS takeid` | set the sequencer focus |
| `UPNEXT takeid` | set the preview to that item without moving the focus |
| `UNCUE takeid`, `UNCUEALL` | remove one, or every, cued item |
| `CLFB buffer` or `CLFB buffer:layer` | clear a framebuffer, or one layer of it |
| `CLRA` | clear all framebuffers |
| `LAYEROFF buffer:layer` | take a layer off air using its out transition |
| `RESUME buffer` or `RESUME buffer:layer` | resume |
| `GPI n` | act as if simulated GPI number n was triggered from outside (up to 64 simulated inputs on Ross's switcher page) |
| `DATALINQKEY takeid:key:value`, `TEMPLATEDATA takeid:object:property:value` | set data on an item (in the newer PDF only) |
| `CHANFOCUSSTORY`, `FOCUSSTORY`, `GAMESTATE`, `ROUTEIPIN` | story focus, an as-run entry, and a clean IP input switch (newer PDF only; `GAMESTATE` syntax not captured) |

Quirks: Ross's own examples are inconsistent about zero padding (`0000` for some buffers and `0` for others,
`0005` and `5` for take ids); whether padding is required is not documented, and a robust adapter should
accept both. An older Smart GPI note (snippet only) shows a different form of `GPI`.

## How it is built inside XPression (mostly not published)

Ross documents only the setup. RossTalk is listed as a kind of "GPI board" in XPression's hardware setup, so
it is a **listener inside the application, beside the GPI hardware**; `GPI n` goes through the same trigger
mapping as a real contact closure. One timing fact is published: CUE then SWAP gives air with no frame delay.
Nothing is published about queueing, order across connections or latency. A guess: commands run in the order
they arrive and are mapped onto the sequencer and the scene director.

## Licence and legal (not advice)

- The XPression command list is published openly on Ross's help site and in a public PDF. No page read calls
  RossTalk "proprietary" in so many words; a Ross support article (403 to the fetcher) was seen only as a snippet.
- The PDF has a general copyright notice (no copying without permission) and says patents are issued and pending.
  No licence grant and no limit on compatible software was found; no trademark policy for the name was found.
- Others have built clients and servers: a Bitfocus Companion XPression module (MIT licence) sends the commands
  and a Companion listener on 7788 is reported (snippet only).
- A guess: implementing the wire format is probably fine, but get a lawyer's view, do not copy Ross's text, and
  be careful with "RossTalk" and "XPression" in product names.

## Could not be verified

Any reply bytes from XPression; the multi-client policy, idle timeout and how a bad command is answered; the
exact `GPI` argument form; whether padding is required; the `GAMESTATE` syntax; the 403 article.

## If we add an adapter later

It is small: a TCP listener on 7788 that reads `VERB a:b:c` lines and maps them onto GrapiX's own commands
(6.7), keeping the zero-based framebuffer rule explicit. Capture real XPression traffic first to settle replies,
padding and several clients; keep it a thin layer; and name it without the vendor's marks until the legal view
is in. Sources: the Ross XPression communication help page, the Ross RossTalk commands PDF (4802DR-403-35), the
Ross automation device sheet for XPression (4910DR-500-02) and the Bitfocus Companion XPression module.
