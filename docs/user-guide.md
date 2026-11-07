# User Guide

AI Dubbing Studio has two kinds of user:

- the **host**, who speaks and runs the session
- **listeners**, who hear the host live in their own language

Listeners don't need an account. The host has one.

This describes the app as it works today. Hosts can do everything below.
Listeners can find a session and pick a language (see [Audio](#audio)).

## Host

### 1. Create an account and log in

- **Create an account** (`/register`): your name, email and a password of 12 to
  128 characters. Very common passwords are refused. You are logged in straight
  away.
- **Log in** (`/login`) next time. A login lasts 12 hours. Only 5 login
  attempts a minute are allowed from one network; after that, wait a minute.
- Password reset isn't available yet; ask whoever runs the app.

### 2. Create a session

Open the **Studio** (`/studio`) and fill in **Create a session**:

1. **Session title.**
2. **Spoken language:** the language you'll talk in. Gemini detects the actual
   language by itself; this one can't also be a target.
3. **Target languages:** up to 5. Each one is a separate paid translation
   stream.
4. **Translation provider:** Gemini Live Translate.
5. Tick both **Consent** boxes: the speaker agrees to have their voice
   replicated, and listeners will be told the audio is AI-generated.
6. Select **Create session**.

The session is created as **Not live yet**, with a six-character **session
code**. Share it with **Copy code**, or send the link with **Share link**.
Listeners can look the session up before it starts.

### 3. Go live

Select **Go live**. Each target language gets its own translator, which starts
within a second or so. The address bar shows the session (`/studio?session=…`),
so you can reload the page or come back to it.

The **Microphone** card lets you pick and test your input, but the app doesn't
send your voice yet (see below).

### 4. End the session

Select **End session** and confirm. Every language stops within a few seconds.
An ended session can't go live again; select **Create a new session** for the
next one. Its code is free to be reused by a later session.

## Listener

1. **Join:** open the link from the host (`/j/CODE`), or go to **Join a
   session** (`/join`) and type the code. Upper or lower case both work.
2. If the host hasn't gone live yet, the page says so and checks again every
   few seconds.
3. Once the session is live, you see its title, the host and the spoken
   language. Pick **Your language** and select **Start listening**.
4. If the session has ended, the page says so.

## Audio

**Start listening** shows "Listening isn't available yet". The translators work
from a recording on the server and write their translations to files there,
which lets the team check the translation.

## Good to know

- The microphone needs a secure connection (HTTPS, or `localhost`).
- Irish isn't offered, because the translation model doesn't support it.
- Translated audio is AI-generated.
