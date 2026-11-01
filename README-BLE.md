# Onewheel XR BLE inventory

This inventory comes from a live XR with hardware 4206 and Gemini firmware 4134,
cross-checked with the obsolete OneWave APK and the
[OWCE protocol reference](https://github.com/OnewheelCommunityEdition/OWCE_App).
Unknown fields remain unknown; having write permission does not establish that
writing is safe.

## Services

| UUID | Service | Live characteristics |
|---|---|---:|
| `e659f300-ea98-11e3-ac10-0800200c9a66` | Onewheel vendor service | 34 |
| `00001801-0000-1000-8000-00805f9b34fb` | Generic Attribute (GATT) | 1 |

The latest live discovery returned **two services and 35 characteristics**.
The Generic Access service (`1800`) appeared in an earlier BlueZ cache, but was not
present in the latest live enumeration.

## Vendor characteristics

Every abbreviated identifier below uses the suffix
`-ea98-11e3-ac10-0800200c9a66`. For example, `e659f31b` means
`e659f31b-ea98-11e3-ac10-0800200c9a66`.

`R/W/N` means read, write, notify. WheelSoul does not use configuration writes.

| Identifier | Permissions | Meaning / evidence |
|---|---|---|
| `e659f301` | R/W/N | Board serial number |
| `e659f302` | R/W/N | Riding mode |
| `e659f303` | R/W/N | Battery percentage |
| `e659f304` | R/W/N | Low-battery warning field; detailed semantics unverified |
| `e659f305` | R/W/N | Low-battery warning field; detailed semantics unverified |
| `e659f306` | R/W/N | Battery serial number |
| `e659f307` | R/W/N | Pitch |
| `e659f308` | R/W/N | Roll |
| `e659f309` | R/W/N | Yaw |
| `e659f30a` | R/W/N | Ride wheel rotations |
| `e659f30b` | R/W/N | Wheel RPM |
| `e659f30c` | R/W/N | Lights-related field; not used |
| `e659f30d` | R/W/N | Lights-related field; not used |
| `e659f30e` | R/W/N | Lights-related field; not used |
| `e659f30f` | R/W/N | Status/error flags |
| `e659f310` | R/W/N | Controller and motor temperatures |
| `e659f311` | R/W/N | Firmware version / legacy session command |
| `e659f312` | R/W/N | Signed battery current |
| `e659f313` | R/W/N | Ride consumption in Ah |
| `e659f314` | R/W/N | Ride regeneration in Ah |
| `e659f315` | R/W/N | Battery temperature |
| `e659f316` | R/W/N | Pack voltage |
| `e659f317` | R/W/N | Safety headroom; semantics not hardware-validated |
| `e659f318` | R/W/N | Hardware revision |
| `e659f319` | R/W/N | Lifetime whole miles |
| `e659f31a` | R/W/N | Lifetime Ah-related raw value; scale unconfirmed |
| `e659f31b` | R/W/N | Battery cell-group samples |
| `e659f31c` | R/W/N | Last-error field in reference; implementation/format unconfirmed |
| `e659f31d` | R/W/N | Unknown |
| `e659f31e` | R/W/N | Unknown |
| `e659f31f` | R/W/N | Unknown |
| `e659f320` | R/W/N | Unknown |
| `e659f3fe` | Notify only | Serial Read: legacy authentication challenge |
| `e659f3ff` | Write only | Serial Write: legacy authentication response |

`e659f3fd` also appears in the APK but was **not** present on the tested board.
Its meaning is unknown.

### Standard characteristic and descriptors

- GATT Service Changed: `00002a05-0000-1000-8000-00805f9b34fb`, indicate only.
- User Description (`2901`) on all 34 vendor characteristics.
- Client Characteristic Configuration (`2902`) on all vendor characteristics except
  Serial Write.
- Live description strings are only `Data#01` through `Data#32`, `Serial Read`,
  and `Serial Write`; they do not identify the unknown fields.

## Encodings used by WheelSoul

Most values are two-byte big-endian integers.

| Value | Conversion |
|---|---|
| Pack voltage | Unsigned integer × 0.1 V |
| XR current | Signed integer × 0.002 A; positive discharge, negative charge/regen |
| Speed | Absolute signed RPM × 0.91766 × 60 / 1000 km/h |
| Current ride | Unsigned rotations × 0.91766 / 1000 km |
| Lifetime distance | Unsigned whole miles × 1.609344 km |
| Controller/motor temperature | `310`: byte 0 controller, byte 1 motor, degrees Celsius |
| XR battery temperature | `315`: byte 1, degrees Celsius |
| Gemini 4134 cells | Byte 0 group index 0-14; byte 1 × 0.02 V; index 15 unused |

WheelSoul conservatively treats a zero motor-temperature byte on supported legacy
XR boards as unavailable and displays `-`, including for older cached readings.
It does not substitute an estimated room temperature or hide valid zero readings
such as current, speed, or cell imbalance.

A cell-group reading represents one of the 15 series groups, not an individually
measurable parallel cell. Full min/max/average/imbalance calculations need all
15 groups fresh within 30 seconds.

The community reference describes a packed cell encoding from firmware 4141:
high four bits index, low 12 bits × 0.0011 V. Its decoder is covered with synthetic
tests, but WheelSoul's current local authentication gate does not support that
firmware. Do not confuse decoder coverage with board compatibility.

XR modes: Sequoia 4, Cruz 5, Mission 6, Elevated 7, Delirium 8, Custom 9.
Mode 0 indicates locked telemetry on the tested firmware.

## Local authentication and write boundary

The implementation is restricted to legacy XR hardware 4000-4209 and firmware
4001-4140; only 4206/4134 has been tested on a real board.

1. Read hardware, firmware, and mode.
2. If locked, subscribe to Serial Read and write the **existing** firmware value
   to `311` as the documented session command.
3. Accumulate the 20-byte challenge. Keep its first three bytes, calculate MD5 over
   challenge bytes 3-18 plus the public legacy protocol salt, and append an XOR
   checksum over the resulting 19 bytes.
4. Stop the challenge subscription and write the response to Serial Write.
5. Verify unlocked telemetry and unchanged hardware/firmware identity.
6. Maintain the session by writing the existing firmware value every 10 seconds.

This is the legacy protocol, not modern cryptographic authentication. There is no
cloud login and no firmware upload. No riding mode, lights, battery settings, or
other configuration characteristics are written.
