---
name: Create Skill Showcase Video
alias: motion_create_skill_showcase_video
description: Turn any skill's SKILL.md into a 60-120s video presentation.
type: tools: motion designer
subtype: video
tags: video, presentation, showcase, explainer, skill, pipeline
author: Sonic
---

## Purpose

Turn any user skill (its `skills/<alias>/SKILL.md`) into a **60–120 second video presentation**. This is a reusable instruction pipeline for an agent, not a one-off video: on input you get any skill, on output you get a finished promotional/explainer video. The video must explain what the skill does, who it is for, how it works, show a result, and end with a CTA — using only facts traceable to the source `SKILL.md`.

## Use When

- asked to make a promo, showcase, or explainer video **for a specific skill**
- input is a skill alias or a path to `skills/<alias>/SKILL.md`, output is a video
- need a universal pipeline: "any skill in → 60–120s presentation video out"

## Do Not Use When

- making a marketing video that is **not** about a concrete source skill
- duration is outside 60–120 s (shorter: simple social cut; longer: use `make_long_movie`)
- a narrative movie with characters, locations and plot is requested — use `make_long_movie`
- no motion-designer generators/TTS available — return the scenario as a storyboard instead

## Inputs

- **source skill** (required): alias (e.g. `gamedev_create_video_background`) or path `skills/<alias>/SKILL.md`; if only a topic is given, first resolve it to an existing skill
- **target aspect** (optional): `16:9` (default) or `9:16`
- **language / voice** (optional): RU/EN, preferred TTS voice
- **style inputs** (optional): brand palette, references, typography, mood
- **delivery spec** (optional): resolution (`720p`/`1080p`), bitrate, max file size

## Rules

1. Total duration is **60–120 s**; never exceed.
2. One locked visual style across **all** scenes (shared palette, typography, references, motion language).
3. Scene count is **6–12 scenes**; each generated clip is **4–15 s** (generator limit) — plan cuts, not long takes.
4. **No invented facts:** every claim in the video must be traceable to the source `SKILL.md` (Purpose, Use When, Workflow, Validation, Output).
5. On-screen text is added as **overlay** (not baked into generation — image/video models mangle text); keep it readable: safe margins ≥5%, contrast ≥4.5:1, min font ~48 px at 1080p.
6. Voiceover must fit scene timing: ≈2.8 words/sec RU, ≈3.0 words/sec EN; measured VO length must be ≤ scene duration (0.3–0.5 s padding).
7. Lip-sync/dialogue scenes (if any): PROMPT must name the speaker, quote the exact line, request natural mouth motion, and include **"No music"** so the audio channel stays clean.
8. Every scene must have a VO cue; every scene must have at least one on-screen keyword.
9. CTA is mandatory in the final beat.

## Workflow

### Stage 0 — Read and analyze the source skill

1. Read `skills/<alias>/SKILL.md` (and `description.md` if present).
2. Extract the essence into a **skill brief** (this drives the whole video):
   - **What it does** — Purpose in one sentence
   - **Who it is for** — Use When / audience
   - **Inputs → Outputs** — what goes in, what comes out
   - **Key steps** — top 3–6 workflow steps (shortened)
   - **Value** — why it matters, strongest benefit
   - **Example result** — what a finished artifact looks like (from Output section)
   - **CTA** — what the viewer should do next
3. If anything is unclear or missing in the skill, ask the user — never invent.

### Stage 1 — Scenario (60–120 s)

Build a beat table with **6 beats** mapped onto **6–12 scenes**:

| Beat | Role | Suggested timing | Scenes |
|---|---|---|---|
| Hook | grab attention, name the skill | 0–6 s | 1 |
| Problem | pain the skill solves | 6–16 s | 1–2 |
| What it does | one-line value proposition | 16–30 s | 1–2 |
| How it works | 3–6 steps of the workflow | 30–75 s | 3–5 |
| Example result | show the artifact/output | 75–100 s | 1–2 |
| CTA + outro | call to action, end card | 100–120 s | 1–2 |

Budget rule: `scene_count = round(total_duration / avg_clip)`, `avg_clip` 8–10 s. If the total needs 12 scenes, keep each at 6–10 s. Cap at 12 scenes.

For each scene record: `id, beat, start, duration (4–15 s), visual concept, VO script, on-screen text`.

### Stage 2 — Concept prompts

Write a generation prompt per scene using the templates in **Concept prompts** below. One prompt per scene type; never reuse a raw scene as a prompt.

### Stage 3 — Lock visual style

1. Define style tokens: 3–4 color palette, 1–2 font families, motion language (e.g. slow camera push, 2D flat + 3D product shots).
2. Generate **one style keyframe** first (best scene as anchor).
3. Use that keyframe as a **style reference** for all other scene keyframes (reference-based image gen, e.g. `gen_or_edit_image_flux2pro_with_refs`) so palette/composition stay consistent.
4. Keep the same keyframe as `IMAGE-INPUT` when animating each scene for visual continuity.

### Stage 4 — Asset generation pipeline

Order (parallelize where marked):

1. **Keyframes (parallel):** one image per scene via `create_image_flux` or `gen_or_edit_image_flux2pro_with_refs` (pass the style keyframe as ref). Upscale if needed with `image_upscale_ai`. Review the storyboard with the user before animation.
2. **Clips (parallel, after keyframes):** animate each keyframe with a video model: `image_or_video_to_video_seedance` (default; `DURATION` 4–15 s, `ASPECT_RATIO` 16:9/9:16, `RESOLUTION` 720p/1080p) or `image_to_video_veo3` / `image_to_video_kling` / `image_or_video_to_video_grok` / `gen_video_wan` when a specific model fits better. For lip-sync scenes use `image_to_video_kling` (avatar + sound input) and follow Rule 7.
3. **Voiceover (parallel with clips):** one TTS segment **per scene** via `text_to_speech_elevenlabs` (`MODE: tts`, `VOICE_ID`, `MODEL_ID: eleven_multilingual_v2` for RU, `OUTPUT_FORMAT: mp3_44100_128`); alternatives `text_to_speech_gemini` / `text_to_speech_chatterbox` / `text_to_speech_indextts`. Verify each segment duration against the scene (Stage 5).
4. **Music (parallel):** instrumental bed via `music_create_instrumental` (Suno) or `music_gen_edit_acestep` / `generate-music-with-lyria`; length ≈ total video, ducked −18…−22 dB under VO.
5. **SFX (parallel):** `video_to_audio_foley` for scene-synced effects, or `gen_sound_elevenlabs` for transition whooshes/ticks.
6. **Assemble (serial, after all assets):** with `video_edit_essentials` — trim each clip to its exact scene duration, concat in beat order, add title/keyword overlays (`render_remotion` for animated text, or HTML overlay via `image_edit_essentials`), then mix audio track: VO + music + SFX with correct gains. Check total duration.
7. **Upscale (optional):** `video_upscale` (Topaz) to fullHD/4K if delivery requires it.
8. **Export:** H.264 MP4, 1080p, ≈8–12 Mbps (16:9) / ≈6–10 Mbps (9:16), audio AAC 192 kbps; target size ≈ `duration × bitrate / 8`.

Every generated asset gets a meta section (`TYPE: file/video` or `file/sound`, `SECTION_ID` mirroring the path) before generation — see the meta-section workflow.

### Stage 5 — Voiceover writing and sync

1. Word budget: total words ≈ `total_seconds × 2.8` (RU) or `× 3.0` (EN); for 90 s that is ~250 RU / ~270 EN words.
2. Per scene: `words = scene_seconds × rate`; write the VO script to that length.
3. Build a **cue sheet**: `scene id | start–end | VO text | words | target seconds`.
4. Generate TTS per scene, measure real duration, and enforce: `vo_duration ≤ scene_duration − 0.4 s`. If VO is longer — shorten the script, never stretch the video.
5. Place each VO segment at its scene start during the audio mix.

### Stage 6 — Validation

Run the **Validation** checklist below; fix issues before delivery.

## Concept prompts

Template for every scene. Fill placeholders from the skill brief and style tokens:

```text
{SCENE_TYPE} scene for a {STYLE} explainer video. {SUBJECT}. Palette: {PALETTE}. Camera: {MOTION}. Mood: {MOOD}. No text in the image. No music. {DIALOGUE_RULE if lip-sync}
```

Per scene type:

- **Title/hook:** `Bold hero shot of {SUBJECT} representing {SKILL_NAME}, dramatic light, logo-colored accents, palette {PALETTE}, slow camera push-in, mood confident. No text in the image.`
- **Problem:** `Visual metaphor of {PAIN}: {METAPHOR}, muted desaturated palette {PALETTE}, subtle camera drift, mood tense. No text in the image.`
- **Explainer (what it does):** `Clean abstract visualization of {SKILL_FUNCTION}: {FLOW_METAPHOR}, flat 2D style, palette {PALETTE}, gentle pan, mood clear and optimistic. No text in the image.`
- **Process step:** `Step {N} of {TOTAL}: {STEP_ACTION} shown as {VISUAL}, numbered composition, palette {PALETTE}, steady camera, mood focused. No text in the image.`
- **Result demo:** `Showcase shot of the finished {ARTIFACT}: {ARTIFACT_DESCRIPTION} from the skill Output, rich palette {PALETTE}, slow orbit/zoom, mood impressive. No text in the image.`
- **Final/CTA:** `End card background matching {PALETTE} with clear negative space in the center for a CTA overlay, soft motion, mood inviting. No text in the image.`

> All on-screen text is overlaid in post (Stage 4.6) — keep `No text in the image` in every generation prompt.

## Visual style

- **Palette:** pick 3–4 colors from the skill's brand or a neutral tech palette; keep ratios stable (60/30/10) across scenes.
- **Typography:** one display font + one body font; headings ≥48 px, body ≥32 px at 1080p; never put body text below 5% safe margin.
- **Consistency:** single style keyframe reused as reference for all scenes; same lighting direction, same camera language.
- **Readability:** text overlays on a scrim/gradient behind them; contrast ≥4.5:1; max ~6 words per on-screen line.

## Validation

- total duration is within **60–120 s**
- scene count ≤ 12; every clip 4–15 s
- one consistent style across all scenes (palette, typography, keyframes)
- cue sheet complete: every scene has VO, VO duration ≤ scene duration − 0.4 s
- on-screen text readable (safe margins, contrast, font sizes) and spelled correctly
- CTA present in the final beat
- every claim about the skill traceable to its `SKILL.md`; **no invented facts, features, or results**
- lip-sync scenes have "No music" and named speaker + exact line in PROMPT
- audio mix: VO clear above music, no clipping, no gaps >1 s, music ducked −18…−22 dB
- format: H.264 MP4, correct aspect/resolution/bitrate; file size matches the estimate
- skill brief, cue sheet and final video all delivered together

## Recipe

1. Read source `SKILL.md` → write a **skill brief** (what/for whom/inputs/outputs/steps/value/result/CTA).
2. Build a **6-beat scenario** (hook → problem → what → how → result → CTA) as 6–12 scenes × 4–15 s.
3. Write **concept prompts** per scene from templates; lock **visual style** tokens.
4. Generate **one style keyframe**, then keyframes for all scenes (parallel, ref-based).
5. Animate keyframes → clips (parallel): `image_or_video_to_video_seedance` default, `image_to_video_kling` for lip-sync.
6. VO per scene (`text_to_speech_elevenlabs`), music (`music_create_instrumental`), SFX (`video_to_audio_foley`) in parallel.
7. Assemble with `video_edit_essentials`: trim → concat → overlays → audio mix; `video_upscale` if 4K.
8. Run Validation checklist; deliver video + cue sheet + brief.

## Output

- final video: H.264 MP4, 16:9 or 9:16, 60–120 s, spec-compliant bitrate/resolution
- meta sections for all generated assets (video/sound)
- skill brief + voiceover cue sheet (for future edits and sync checks)
- file paths, duration, resolution, bitrate and size reported to the user
