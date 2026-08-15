# [1.4.0](https://github.com/sokol-matija/youtube-not-interested/compare/v1.3.0...v1.4.0) (2026-08-15)


### Bug Fixes

* **comments:** add padding to watch column on narrow widths to prevent text clipping ([cf0fd51](https://github.com/sokol-matija/youtube-not-interested/commit/cf0fd51f97db6c7b59b4d93cc3b905ab87d3dbe3))
* **comments:** improve scroll-jump prevention with event-driven snap-to-top ([c6c18eb](https://github.com/sokol-matija/youtube-not-interested/commit/c6c18eb5bf2e67fb84df4e77e32cb641d63106c7))
* **comments:** prevent scroll jump when clicking comments button ([75f59f9](https://github.com/sokol-matija/youtube-not-interested/commit/75f59f9d4e68b18508d71077b12f5a7c695e0276))
* **extension:** prevent context invalidation errors when extension reloads ([418e5f4](https://github.com/sokol-matija/youtube-not-interested/commit/418e5f44828075225e59d29c8662700ef6433cf9))
* **watch:** add padding to playlist grid when mini-guide is hidden ([e379391](https://github.com/sokol-matija/youtube-not-interested/commit/e3793912bb0dea7e163fafe068003a67dbd03609))
* **watch:** clarify playlist grid gutter scope in comment ([e1ff0e6](https://github.com/sokol-matija/youtube-not-interested/commit/e1ff0e68e04db35ad914c99a1db4a733d300e1fc))
* **watch:** clarify watch-later class reference in comment ([d5d0f50](https://github.com/sokol-matija/youtube-not-interested/commit/d5d0f50521a4995223256b918ee6d2de11211af3))
* **watch:** hide unavailable videos info banner on watch later page ([0611a41](https://github.com/sokol-matija/youtube-not-interested/commit/0611a41d42125aec021b623439ca25c1332a15a3))
* **watch:** reposition playlist button to title-row to prevent title collision ([b3c40b2](https://github.com/sokol-matija/youtube-not-interested/commit/b3c40b230ec42a05b046314d6c09cc1c04bb6d62))
* **watch:** restrict playlist grid gutter fix to watch later pages ([16a7be9](https://github.com/sokol-matija/youtube-not-interested/commit/16a7be9c4bb3d8fd577a1b90ad9ba2a339628aab))
* **watch:** use margin-left instead of padding-right for playlist alignment ([399948e](https://github.com/sokol-matija/youtube-not-interested/commit/399948e837cb4749de70d1b2583d7060995fbf38))


### Features

* **bridge:** phone summary API — share a video, get a push, read it on mobile ([b725b0f](https://github.com/sokol-matija/youtube-not-interested/commit/b725b0fa595e9fff8bc801be5b7de07d9050664b))
* **keyboard:** add 'c' shortcut for cinema mode toggle ([ca5f305](https://github.com/sokol-matija/youtube-not-interested/commit/ca5f305a22b0ab1e8490cd88c8c9ee09f8d9e593))
* **pip:** add options toggle and document.documentElement bridge for auto picture-in-picture ([36d8563](https://github.com/sokol-matija/youtube-not-interested/commit/36d8563b50bf70595984a8492ba328020e31dc4f))
* **pip:** auto-minimize Chrome on app-switch to trigger picture-in-picture ([0831067](https://github.com/sokol-matija/youtube-not-interested/commit/0831067d9bd65171d1c8e0b5ff22c6dd8855a785))
* **watch:** add toggle to hide native watch info (views & date) ([c9493e8](https://github.com/sokol-matija/youtube-not-interested/commit/c9493e8ef726a2e706749fd205918da5ce973ec9))
* **watch:** add toggle to hide views & upload date pills, relocate playlist button to actions row ([58a8ca4](https://github.com/sokol-matija/youtube-not-interested/commit/58a8ca49464406fb5ee2e2896a41d9764128db2c))

# [1.3.0](https://github.com/sokol-matija/youtube-not-interested/compare/v1.2.0...v1.3.0) (2026-07-12)


### Features

* **home:** hide card after Not interested to remove YouTube placeholder ([93824b1](https://github.com/sokol-matija/youtube-not-interested/commit/93824b103e6d53928a40da2b1c74046924be5121))
* **pip:** add manual toggle and auto picture-in-picture support ([fc1b291](https://github.com/sokol-matija/youtube-not-interested/commit/fc1b291f2e3d8b9a4d44ce7f86adac3989efbf0b))


### Performance Improvements

* **home:** drop redundant will-change on watch pills ([4b5f5be](https://github.com/sokol-matija/youtube-not-interested/commit/4b5f5be13d78447f0052ce6776f5f2ab5675c61e))

# [1.2.0](https://github.com/sokol-matija/youtube-not-interested/compare/v1.1.1...v1.2.0) (2026-07-07)


### Bug Fixes

* **transcript:** throttle fetches, support proxies, surface errors as toasts ([3012f94](https://github.com/sokol-matija/youtube-not-interested/commit/3012f949da9e49ec1efcd1e2b406d42f0734df42))


### Features

* **home:** auto-hide masthead + chip bar on scroll-down ([2ca6a85](https://github.com/sokol-matija/youtube-not-interested/commit/2ca6a858a6cfd70822b36d8a1b8db1079d0e468f))
* **options:** add toggle to hide mini guide sidebar and reclaim its space ([938bdca](https://github.com/sokol-matija/youtube-not-interested/commit/938bdca6010d6a5fead9d7f4877fd017687e263d))
* **summarize:** add silent auto-summarize that opens panel without TTS ([598693a](https://github.com/sokol-matija/youtube-not-interested/commit/598693a5b5b86dcfdb9b5a4f865e9e9691849ef1))
* **watch:** add cinema mode that hides everything but the video ([8e64b88](https://github.com/sokol-matija/youtube-not-interested/commit/8e64b88693d0c0f36b9a1cd238b57f0f9e5b6305)), closes [#movie_player](https://github.com/sokol-matija/youtube-not-interested/issues/movie_player)
* **watch:** daily watch counter pills + restyle views/age as pills ([eafb77e](https://github.com/sokol-matija/youtube-not-interested/commit/eafb77e8c5cb1a54d1cc952d4e03316f254c1438))

## [1.1.1](https://github.com/sokol-matija/youtube-not-interested/compare/v1.1.0...v1.1.1) (2026-06-15)


### Bug Fixes

* **watch:** detect mix/radio playlists via start_radio + RD list prefix ([7a8c068](https://github.com/sokol-matija/youtube-not-interested/commit/7a8c06823c027b113f4f42be3a1e1118219dccd6))
