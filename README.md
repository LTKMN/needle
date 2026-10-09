# Needle

A Spotify player that runs in a single browser tab, built around **radio as the default verb**. Play any track and Needle grows an endless queue from it. You tune how that queue is built with sliders instead of trusting a black box.

It's one self-contained `index.html`: no build step, no backend, no dependencies beyond Spotify's Web Playback SDK.

## What it does

- **Search and play** tracks, albums, artists and your playlists, with Spotify streaming in the tab via the Web Playback SDK.
- **Radio from anything.** Playing a track starts a radio. Its candidates come from the seed artist, similar artists, their Spotify tracks and your liked songs. When the queue runs low it fetches more, and it drifts toward artists you actually let play.
- **A shuffle you can see and tune.** Needle keeps its own play/skip history, and seven sliders shape every queue:
  - *Order:* artist spread, freshness (push back recent plays), skip memory, liked boost, unheard boost
  - *Radio:* reach (how far from the seed), **underground** (from household names to bands with a handful of listeners)
- **Genre trailheads.** Pick "punk", "drum and bass", "city pop" (or type any genre). Needle finds a good entry track for that genre and starts a station that stays in it.
- **Playlist stations.** Open a readable playlist and choose **START PLAYLIST RADIO**. Needle snapshots all loaded tracks and uses artists across the playlist, weighted by their share of distinct songs. The **playlist mix** slider targets originals versus related discoveries: 0% is discovery-only, 100% is originals-only, and intermediate values fill shortages from the available side.
- Change the mix in the source playlist or queue to rebuild upcoming station tracks. The current song, manually queued songs, and tracks explicitly moved to next stay in place. `P` marks source originals and `D` marks discoveries. Originals can recur in later batches; discoveries exclude every source song, including alternate versions. The snapshot and station mix survive reloads.
- **Single-song stations.** Originals-only stations repeat a sole source. Starting one while its matching queue entry is playing preserves that entry and position and queues the next copy.
- **Discover.** Seed artists in, unfamiliar related artists out, with an "adventure" control and a "not for me" ban list.
- **Recently played** merges Needle's own instant play log with Spotify's history from your other devices.
- Two-color theme, regenerated each session (◐ for a new one). Keyboard: `space` play/pause, `/` search, `shift+←/→` prev/next, `←/→` seek, `s` shuffle, `l` like, `r` radio.

## Setup

You need **Spotify Premium** (Family plan members count). The Web Playback SDK refuses free accounts.

1. Serve the folder over HTTP. Spotify only allows `https://` redirect URIs or the loopback IP, so use `127.0.0.1` rather than `localhost`:
   ```sh
   npx http-server -a 127.0.0.1 -p 8888 -c-1
   ```
   Or host `index.html` on any static host with https.
2. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard):
   - **Redirect URI:** the exact URL you open, e.g. `http://127.0.0.1:8888/`. The setup screen shows it.
   - **APIs used:** Web API and Web Playback SDK.
3. Open the page, paste your app's **Client ID**, and log in.

Login uses PKCE, so there's no client secret and no server. The Client ID, tokens, history and settings stay in your browser's `localStorage`. Nothing is sent anywhere except the services listed below.

## Data sources

Spotify's 2026 Web API changes for development-mode apps removed recommendations, related artists, popularity and follower counts. Needle uses open data instead:

| Source | Used for |
|---|---|
| [Spotify Web API](https://developer.spotify.com/documentation/web-api) + Web Playback SDK | playback, search, library, playlists |
| [ListenBrainz](https://listenbrainz.org) | similar artists, genre tag radio, artist listener counts (popularity) |
| [MusicBrainz](https://musicbrainz.org) | resolving artist names to IDs (rate limited to 1 req/s) |
| [Deezer API](https://developers.deezer.com/api) (JSONP) | related artists and fan counts for artists ListenBrainz doesn't know. Used only after a shared track title confirms it's the same artist |

## Known limits

- **Playlists you don't own:** Spotify only lets development-mode apps read the contents of playlists you own or collaborate on. Followed playlists (marked ▫) still play, but through Spotify's own queue and shuffle. Save a copy to get Needle's shuffle and radio.
- **Five users per app:** Spotify caps a development-mode app at five users. Each person should register their own Client ID.
- **Queue changes:** editing upcoming tracks does not resend playback mid-song. Needle hands off to the updated next track at the current track's end.
- **Tiny artists:** the smallest artists may not be on Spotify at all. Needle skips them, falling back to the seed artist's catalogue or your liked songs.
- **Limited discovery supply:** endpoints never substitute the other side. Intermediate mixes are targets rather than guarantees when eligible tracks run short. Playlist stations stay anchored to their source artists and neighbours; they do not fill from unrelated liked songs or refetch later playlist edits.

## Verification

Run the synthetic playlist-radio regression suite with Node:

```sh
node --test tests/playlist-radio.test.cjs
```

The tests execute the application's inline script with inert browser/player boundaries. They cover full playlist pagination, mix selection, current/manual entry identity, queue handoff, serialized generation and low-water retries, synchronous SDK activation, persistence, control nesting, and ordinary radio behavior without Spotify credentials or audio. SDK activation tests check call ordering, not live autoplay or DRM.

## License

[MIT](LICENSE)
