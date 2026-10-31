# User Guide

AI Dubbing Studio has two kinds of user:

- the **host**, who speaks and runs the session
- **listeners**, who hear the host live in their own language, with captions

Listeners don't need an account. The host signs in.

This describes the app as it works today. The MVP's pages are planned in the
[decision records](adr/index.md) (ADR-0014).

## Host

### 1. Sign in

Go to **Host sign-in** (`/signin`) and enter the host email and password.
Password reset isn't available yet; ask whoever runs the app.

### 2. Create a session

On **Create session**:

1. Enter a **Session title**.
2. Pick the **Spoken language** you'll talk in. It labels the captions; Gemini
   detects the actual language automatically.
3. Pick one or more **Target languages** (up to 5). Tap **+ More** for the full
   list. Each language is a separate paid translation stream.
4. Optional: tap **Test microphone**, pick your input and check the level meter
   reacts when you speak. Nothing is requested until you tap.
5. Tick both boxes: that the speaker agrees to have their voice cloned, and that
   listeners are told the audio is AI-generated.
6. Tap **Start session**.

The translated voice is matched automatically from your live speech, so there's
no recording step. Audio is passed straight through and never stored.

### 3. Run the session (Studio)

- **Session code:** share it with listeners using **Copy**, or **Share link** /
  **Copy link**.
- **Total listeners** and **Latency** show how the session is doing.
- **Microphone:** switch input while live without a gap. Turn **Voice cleanup**
  off for a mixer, virtual cable or video audio, or that audio can be cut to near
  silence.
- **Language tracks:** the state of each language. If one shows an error, tap
  **Retry**; the other languages keep working.
- **Captions preview:** check what listeners are reading.

### 4. End the session

Tap **End session** and confirm. This stops every language and disconnects all
listeners. A session also ends by itself if the host has been disconnected for
60 seconds, or after 4 hours (both can be changed in `.env`).

## Listener

1. **Join:** open the link from the host, or go to the app and enter the
   **room code** on **Join a session**.
2. **Check your audio:** choose your language, tap **Play test sound**, set the
   **Volume**, and tick the box once you've heard it.
3. Tap **Enter session**.
4. Listen live, with the original and translated captions on screen. You can
   switch language from the buttons without leaving.

If you see **Audio is paused**, tap **Tap to resume audio**: browsers need a tap
before they play sound.

## Good to know

- The microphone needs a secure connection (HTTPS, or `localhost`).
- Irish isn't offered, because the translation model doesn't support it.
- Translated audio is AI-generated.
