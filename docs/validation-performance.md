# Data-validation performance

The town reachability check still uses the same 1.5 m grid, car clearance, collider checks and
connectivity rules. It now prepares polygon edge constants once per proposal and compares squared
distances when deciding whether a grid cell has enough clearance. Flood-fill neighbor offsets are
also allocated once per pass. No result is cached between proposals; in-place data edits remain visible.

## Verification

- The original 11 data-check tests pass, including the unchanged best-of-five threshold of 60 ms.
- A new boundary regression compares clearance against the existing signed-distance function for
  rectangular, diagonal, concave and duplicate-vertex polygons. It also checks in-place polygon edits
  against fresh clones.
- Complete reports matched the preceding implementation for 30 successive in-place bounds/piece
  mutations of shipped data. Browser and tools TypeScript checks passed.

## Local measurement, 2026-10-24

Machine: Apple M4, arm64, 10 logical CPUs. Runtime: Node 24.22.1. The comparison used the checker
immediately before this optimization and the updated checker, with the same shipped data. After
10 warm-up calls each, 20 calls each alternated execution order in one process.

| Measurement             |  Before |   After |
| ----------------------- | ------: | ------: |
| Median process CPU time | 8.75 ms | 5.08 ms |
| Median wall time        | 6.87 ms | 5.15 ms |
| Best wall time          | 5.06 ms | 2.67 ms |

The recorded one-minute host load average was approximately 158. Earlier profiler runs showed
large scheduling pauses, so these measurements describe this local comparison, not a universal
wall-time guarantee or validation on a modest laptop. CPU samples identified repeated polygon
distance calculations and allocation/garbage collection as hotspots before the change.
