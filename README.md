# Shalev Driving Lab

One interactive world for the Bristol FSAI car: **manual driving versus PID,
MPC, F1 imitation and FlyWire**, with the real core-sim2 actuator request,
first-person cockpit, real FSUK geometry and the maths/comparison explanation
on the same page.

**Live:** https://altcar.github.io/mpc-race-studio/

![Driving Lab](lab/screenshot.png)

## One page, three layers

1. **Drive** — Three.js world, chase/first-person camera, WASD manual, PID-PP,
   Stanley, MPC, F1 and FlyWire. Real track, sky, cones, steering wheel that
   turns in first person.
2. **Actuator** — actual speed mode RPM, torque Nm, mechanical brake %,
   steering degrees and slew. Motion follows the actuator-derived acceleration.
3. **Explain** — the live tentacle cost function, soft/hard corridor, bicycle
   model and the F1/FlyWire/MPC comparison with caveats.

## First person

The **First person** button moves the camera into the cockpit. W/S throttle and
brake, A/D steer; the steering wheel rotates with the actual steering angle.
Chase and first-person use the same physics and actuator values.

## Competitions

- **Sprint** — fastest lap, balanced tracking.
- **Track drive** — 11 laps, consistency, higher comfort/soft weights.
- **Skidpad** — figure of eight, lateral/steering stability.
- **Acceleration** — peak speed, straight line, full brake into the orange box.

## Cone contact

Cones are collision-only objects. A cone inside the hit radius turns red and
increments the round's **CONES HIT** counter. The counter and cones reset at the
start of every round. This is a planning/validation counter, not rigid-body
physics.

## Run locally

```bash
python3 -m http.server 8099
# http://localhost:8099
```

Static assets only: no Worker runtime. GitHub Pages rebuilds on every push.

## Source

- `planning_control/` — C++ planner, PID/MPC, core-sim2 actuator mapping
- `planning_control/shalevtest/` — GUI, Foxglove, validation, browser lab
- F1 and FlyWire models exported into `f1_model.json` / `fly_model.json`
- real FSUK geometry in `track_full.json`, `acceleration.json`, `skidpad.json`
