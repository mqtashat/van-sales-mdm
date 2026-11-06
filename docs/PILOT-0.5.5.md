# Android 14 / 0.5.5-pilot
Based on v13 commit 4a9792ca4b042e04bfa2ad912b858dd7079eca80. Same application ID and signing configuration. No database rules or web files changed.

Location: pilot acquisition cadence overrides the legacy sampling interval: 30 seconds after confirmed movement, 60 seconds while stationary/unknown. Work schedule and enabled policy remain authoritative. A request lasts at most 25 seconds; inaccurate first fixes do not stop it. Accept only finite accuracy <=35 m and monotonic/wall-clock age <=30 seconds. Movement must exceed combined accuracy radii and 20 m; implausible jumps are rejected. Duplicate/no-motion observations are not stored as fresh invented coordinates. After five minutes without a stored point, the anchor resets for reacquisition; UI must split gaps and show accuracy. This conservative heuristic can miss slow movement and is not a guarantee of GPS precision. No road snapping. Offline queue preserved; drain attempted every minute while sampling (existing sync may also drain).

Absent blocked packages remain in the desired policy and are enforced again on subsequent sync/package events. Only full package visibility and confirmed absence allow skipping; tracked hidden/unqueryable packages remain failures. Existing recovery journal is retained. Long sync errors have a concise summary and an explicit details dialog.

Field acceptance on first test device: indoor stationary 30 minutes, outdoor stationary 10 minutes, walk and drive with screen off, loss/return of network and GPS, reboot, disable tracking and outside work schedule. Compare actual path, timestamps, gaps and battery. Never interpret filtered gaps as proof of no movement. Review map UI before fleet rollout.

Local environment lacks javac/Gradle/Android SDK; Android unit tests, lint and signed build must pass CI. No physical device testing has occurred for this version.
