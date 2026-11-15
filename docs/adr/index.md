# Architecture Decision Records

Each important technical decision gets one numbered file here.
Accepted ADRs are not edited; a new ADR supersedes an old one.

| ADR                                              | Title                                            | Status   |
|--------------------------------------------------|--------------------------------------------------|----------|
| [0000](0000-template.md)                         | Template                                         | n/a      |
| [0001](0001-audio-fan-out.md)                    | How translated audio reaches listeners (fan-out) | Accepted |
| [0002](0002-session-and-account-storage.md)      | How session and account data is stored           | Accepted |
| [0003](0003-host-authentication.md)              | How hosts sign up, log in and stay logged in     | Accepted |
| [0007](0007-backend-framework.md)                | Hono as the API framework                        | Accepted |
| [0008](0008-separated-container.md)              | Separate the dubbing container from Hono         | Accepted |
| [0009](0009-translation-engine-communication.md) | Session creation contract and provider selection | Accepted |
| [0010](0010-mobile-native.md)                    | React + Vite as a PWA                            | Accepted |
| [0011](0011-audio-handling.md)                   | Mobile audio handling                            | Accepted |
| [0012](0012-serving-pwa-bundle.md)               | Hono serves the PWA                              | Accepted |
| [0013](0013-sfu-client.md)                       | LiveKit client connection in the PWA             | Accepted |
| [0014](0014-pages.md)                            | PWA pages                                        | Accepted |
| [0015](0015-auth-library.md)                     | Better Auth for host login                       | Accepted |
| [0016](0016-schema-validator.md)                 | Zod for schemas and validation                   | Accepted |
| [0017](0017-translation-plane.md)                | Dubbing container framework and runtime          | Accepted |
| [0020](0020-input-audio-stream.md)               | Host audio to workers through LiveKit rooms      | Proposed |
| [0019](0019-translation-worker-runtime.md)       | Go for the translation worker                    | Proposed |
| [0018](0018-autoscaling-architecture-of-translation-container.md) | Redis Streams dispatch for translation workers   | Proposed |
| [0021](0021-how-we-deploy.md)                    | Argo CD on K3s, from a separate deploy repository | Proposed |
| [0022](0022-architecture-tests.md)               | Architecture tests for the worker and the API    | Proposed |
| [0023](0023-livekit-public-endpoint.md)          | LiveKit's public address: Hetzner relay, WireGuard sidecar, Caddy | Accepted |
| [0024](0024-cluster-dashboard.md)                | Headlamp as the K3s cluster's dashboard          | Proposed |

Numbers 0004–0006 were not used.
