# Vision

## What we are building

A map of a cattle station's water infrastructure that the people running it can draw, fix and
carry in their pocket: paddock boundaries, poly pipe runs (with diameter, depth, material and
install date), and the points that matter (troughs, turkey nests, bores, gates, tanks, taps), with
photos taken on site, on satellite imagery, and working where the phone has no signal.

## Who it is for

- **Primary:** whoever looks after the water on a station: the owner, manager or station hand who
  has to find a buried line, a leak or a trough in a paddock that is hours from the homestead.
- **Secondary:** a contractor or new hand who needs to be shown where things are without a
  guided tour; whoever is planning new runs and wants the old ones on the same map.
- **Not for:** survey-grade GIS work (no projections other than WGS 84, no precision guarantees),
  livestock or pasture management, or anyone who needs multi-tenant accounts today (there are no
  user accounts yet; PT33).

## Why it matters

Today that knowledge lives in one person's head, on a whiteboard in the shed, or on a printed map
that was out of date the week after it was drawn. When that person is away or leaves, finding a
line means digging. The places where the information is needed are exactly the places with no
mobile signal, so a website that needs a connection is no help.

## What success looks like

- A station's runs, troughs and paddocks are on one map that someone other than the person who drew
  them can use to walk to the right spot.
- A change made in the paddock with no signal arrives on the server when the phone gets back in
  range, without being lost or silently overwriting someone else's change.
- A printed A3 map of the current state can be produced from the phone in a minute.

## Principles

1. **Works offline first.** Anything the user can do in the field must survive no signal: the map
   tiles, the edits, the photos.
2. **Never lose or silently overwrite field work.** A write that fails says so; a conflict is shown,
   not resolved behind the user's back.
3. **The data is the station's.** Plain GeoJSON in and out (import, export); no lock-in.
4. **Free to run.** Free tiers only (Vercel, Supabase); nothing that costs money per month.
5. **Refuse what is wrong, early.** A shape that is not a shape is refused before it is saved, with
   a reason a person can act on.
