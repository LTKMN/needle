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
- **Playlist stations.** Open a readable playlist and choose **START PLAYLIST RADIO**. Needle snapshots all loaded tracks and rotates through up to eight source artists per discovery batch, so frequently represented artists cannot crowd out the rest of the playlist. Each batch searches up to twenty related artists across those branches and picks distinct primary artists before repeating them. The **playlist mix** slider targets originals versus related discoveries: 0% is discovery-only, 100% is originals-only, and intermediate values fill shortages from the available side.
- Change the mix in the source playlist or queue to rebuild upcoming station tracks. The current song, manually queued songs, and tracks explicitly moved to next stay in place. `P` marks source originals and `D` marks discoveries. Originals can recur in later batches; discoveries exclude every source song, including alternate versions. The snapshot and station mix survive reloads.
- **Wider playlist discovery.** Low reach favors close neighbors of each source artist. Above 60, reach also explores neighbors of a sampled direct neighbor on each branch. Underground controls listener popularity independently of this breadth. Artist spread controls spacing after selection. Seed rotation advances only when a batch is installed and survives reloads; originals-only batches do not advance it.
- **Single-song stations.** Originals-only stations repeat a sole source. Starting one while its matching queue entry is playing preserves that entry and position and queues the next copy.
- **Discover.** Seed artists in, unfamiliar related artists out, with an "adventure" control and a "not for me" ban list.
- **Recently played** merges Needle's own instant play log with Spotify's history from your other devices.
- **Track context menus.** Right-click a track in a list or Needle-owned queue for Play next, Add to queue, Add to playlist, Like/unlike, or Start radio. Queue entries also offer Remove from queue, except for the current song. Playlist destinations are limited to owned or collaborative playlists; failed additions stay open with an error and can be retried.
- **Browser-menu pass-through.** Choose **Browser menu on next right-click** in a track menu to close Needle's menu and let the next right-click use the browser menu once. Normal track-menu capture resumes afterward, including when the bypass was used outside a track or with Shift held. Shift + right-click also passes through without choosing the option first. There is no saved preference or checkbox. Right-clicks outside track lists and Needle-owned queue entries always pass through.
- **Keyboard menus.** Focus a track row and press the context-menu key or Shift+F10. Arrow keys, Home, and End navigate actions; Escape closes the menu and returns focus to the track. Tab closes it and continues normal focus navigation.
- **Transport controls.** In Needle-owned queues, Previous restarts the current song after three seconds; a quick second press selects the preceding song. Next and Previous can reverse a pending skip without using the old song's position. Playback-window requests run sequentially, and only the latest waiting selection is sent to Spotify. Spotify-owned queues use the SDK's next/previous controls.
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
   Playlist addition requires `playlist-modify-public` and `playlist-modify-private`. Existing logins may need to reconnect to grant these permissions; an access-denied playlist action offers **Reconnect Spotify**.
4. Optional: install it as an app (Chrome: ⋮ → Cast, save, and share → *Install page as app*; Edge: ⋯ → Apps → *Install Needle*) so it gets its own window and taskbar icon. In Chrome, adding the site under `chrome://settings/performance` → *Always keep these sites active* stops Memory Saver from unloading it while paused.

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
- **Limited discovery supply:** endpoints never substitute the other side. Intermediate mixes are targets rather than guarantees when eligible tracks run short. Playlist stations stay connected to their source artists through direct neighbors or high-reach second hops; they do not fill from unrelated liked songs or refetch later playlist edits. Sparse catalogues can still require repeated artists.

## Verification

Run the Node regression suite:

```sh
node --test tests/*.test.cjs
```

The tests execute the application's inline script with inert browser/player boundaries. They cover full playlist pagination, mix selection, artist and branch coverage, transactional seed rotation, reach boundaries, current/manual entry identity, queue handoff, serialized generation and low-water retries, synchronous SDK activation, persistence, track-menu capture and pass-through, exact queue removal, playlist-write success and failure, keyboard focus, and ordinary radio behavior without Spotify credentials or audio. Transport regressions cover rapid previous presses, skip reversal before SDK notification, serialized playback requests, obsolete queued targets, and recovery after request failure. Playlist-write tests use a mutable HTTP fixture through the application's API client. SDK activation tests check call ordering, not live autoplay or DRM.

## License

[MIT](LICENSE)
