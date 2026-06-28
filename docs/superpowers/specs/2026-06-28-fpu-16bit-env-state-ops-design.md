# Implement 16-bit FPU environment/state ops

Date: 2026-06-28

## Problem

Four x87 FPU instructions are stubbed out in `src/rust/cpu/fpu.rs`. Their
16-bit operand-size variants only log and trigger `#UD` via `fpu_unimpl()`:

| Function       | Line | Instruction              |
|----------------|------|--------------------------|
| `fpu_fldenv16` | ~418 | `FLDENV` (16-bit)        |
| `fpu_fstenv16` | ~566 | `FSTENV`/`FNSTENV` (16)  |
| `fpu_frstor16` | ~528 | `FRSTOR` (16-bit)        |
| `fpu_fsave16`  | ~543 | `FSAVE`/`FNSAVE` (16-bit)|

The 32-bit counterparts (`fpu_fldenv32`, `fpu_fstenv32`, `fpu_frstor32`,
`fpu_fsave32`) are implemented.

Additionally, the JIT does not dispatch on operand size for these ops:
`instr16_*_mem_jit` call the `fpu_*32` handlers, and `instr32_*_mem_jit`
delegate to the 16-bit jit. So jitted code always uses the 32-bit memory
layout regardless of operand size. The interpreter dispatches correctly
(`instr16_*` -> `fpu_*16`).

## Goals

1. Implement the four `fpu_*16` functions with the correct 16-bit memory
   image layout.
2. Make the layout mode-aware: real-address mode and 16-bit protected mode
   pack the instruction/data pointers differently.
3. Fix JIT dispatch so 16-bit operand size uses `fpu_*16` and 32-bit uses
   `fpu_*32`.
4. Add nasm tests covering the protected-mode 16-bit path against
   real-hardware gdb fixtures.

## Non-goals

- `fpu_*32` real-mode layout. The existing 32-bit code always emits the
  protected-mode 32-bit layout regardless of CPU mode. Fixing that is a
  pre-existing simplification and out of scope here.
- Full emulation of FPU IP/CS/opcode/DP fields. These are not fully
  emulated today (existing tests zero them); the 16-bit packing of those
  fields is best-effort.

## Background: image size vs. layout

Two independent factors determine the in-memory environment image:

- **Operand size** selects the image *size*: 16-bit -> 14-byte env;
  32-bit -> 28-byte env.
- **CPU mode** (real vs. protected) selects how the FPU instruction and
  data pointers are *packed* into the env.

This work targets the 14-byte (16-bit) env, mode-aware on packing.

## Memory layouts (14-byte environment)

Branch on `*protected_mode`.

### 16-bit protected mode

| Offset | Field                     |
|--------|---------------------------|
| +0     | Control word (FCW)        |
| +2     | Status word (FSW)         |
| +4     | Tag word (FTW)            |
| +6     | FPU IP offset (low 16)    |
| +8     | FPU CS selector           |
| +10    | FPU data offset (low 16)  |
| +12    | FPU data selector         |

### 16-bit real-address mode

| Offset | Field                                         |
|--------|-----------------------------------------------|
| +0     | Control word (FCW)                            |
| +2     | Status word (FSW)                             |
| +4     | Tag word (FTW)                                |
| +6     | FPU IP[15:0]                                  |
| +8     | bits 15:12 = IP[19:16]; bits 11:0 = opcode    |
| +10    | FPU data pointer DP[15:0]                      |
| +12    | bits 15:12 = DP[19:16]; bits 11:0 = 0          |

`FSAVE`/`FRSTOR` append eight 80-bit ST registers after the 14-byte env
(total 94 bytes). The 80-bit register format is operand-size independent,
so `fpu_store_m80` / `fpu_load_m80` are reused.

## Implementation

File: `src/rust/cpu/fpu.rs`

### `fpu_fstenv16(addr)`

1. `writable_or_pagefault(addr, 14)`; set `*page_fault` accordingly,
   mirroring `fpu_fstenv32`.
2. Write FCW (`*fpu_control_word`), FSW (`fpu_load_status_word()`),
   FTW (`fpu_load_tag_word()`) at +0/+2/+4.
3. Write IP/CS/DP/data-selector fields per the mode-specific layout above,
   branching on `*protected_mode`. Source fields: `*fpu_ip`,
   `*fpu_ip_selector`, `*fpu_opcode`, `*fpu_dp`, `*fpu_dp_selector`.

### `fpu_fldenv16(addr)`

1. `readable_or_pagefault(addr, 14)`; set `*page_fault` accordingly,
   mirroring `fpu_fldenv32`.
2. `set_control_word(read16(+0))`, `fpu_set_status_word(read16(+2))`,
   `fpu_set_tag_word(read16(+4) as i32)`.
3. Reconstruct IP/CS/DP/data-selector from the mode-specific fields and
   store into `*fpu_ip`, `*fpu_ip_selector`, `*fpu_opcode`, `*fpu_dp`,
   `*fpu_dp_selector` (best-effort; not fully emulated).

### `fpu_fsave16(addr)`

1. `writable_or_pagefault(addr, 94)`.
2. `fpu_fstenv16(addr)`.
3. For `i in 0..8`: `fpu_store_m80(addr + 14 + i*10, st[(stack_ptr+i)&7])`,
   matching `fpu_fsave32`'s register loop.
4. `fpu_finit()` (FSAVE reinitializes the FPU, as in `fpu_fsave32`).

### `fpu_frstor16(addr)`

1. `readable_or_pagefault(addr, 94)`.
2. `fpu_fldenv16(addr)`.
3. For `i in 0..8`: `*fpu_st.offset(((stack_ptr+i)&7))= fpu_load_m80(addr+14+i*10)`,
   matching `fpu_frstor32`.

Remove the `dbg_log!` + `fpu_unimpl()` bodies.

## JIT fix

File: `src/rust/jit_instructions.rs`

For each of the four ops (D9/4 FLDENV, D9/6 FSTENV, DD/4 FRSTOR, DD/6
FSAVE):

- `instr16_*_mem_jit` calls the corresponding `fpu_*16` handler.
- `instr32_*_mem_jit` calls the corresponding `fpu_*32` handler (no longer
  delegating to the 16-bit jit).

The surrounding codegen (modrm resolve, eip bookkeeping, register
spill/reload, page-fault exit) stays identical to the current 32-bit jit
bodies; only the `call_fn1` target name changes between the 16/32 wrappers.

## Testing

File: `tests/nasm/`

The nasm harness runs binaries in 32-bit protected mode (multiboot) and
generates golden fixtures on real x86 via gdb. Tests use the `o16` operand-
size override prefix to emit the 16-bit variant; because the harness runs
in protected mode, this exercises the **16-bit protected-mode** layout
against real hardware.

New tests, modeled on `fstenv.asm` / `fsave_frstor.asm`:

- `fstenv16.asm`: `o16 fnstenv [esp]` (or `o16 fstenv`), then zero the
  undefined / un-emulated fields (IP/CS/opcode/DP) before the final state
  is captured, as `fstenv.asm` does for its 32-bit equivalent.
- `fsave_frstor16.asm`: load known ST values (`fldz`/`fld1`), `o16 fnsave`,
  `o16 frstor`, then zero the un-emulated IP/CS/opcode/DP fields, as
  `fsave_frstor.asm` does.

Run via `make nasmtests` (and optionally `make nasmtests-force-jit` to
cover the JIT path).

### Test coverage limitation

The real-address-mode 16-bit layout cannot be exercised by this harness
(it runs in protected mode). That path is verified by code review against
the Intel SDM layout documented above, not by automated test.

## Verification checklist

- [ ] `cargo build` / wasm build succeeds (no warnings on the touched
      functions).
- [ ] `make nasmtests` passes including the two new tests.
- [ ] `make nasmtests-force-jit` passes (confirms JIT dispatch fix).
- [ ] Manual review of real-mode packing against the layout table.
