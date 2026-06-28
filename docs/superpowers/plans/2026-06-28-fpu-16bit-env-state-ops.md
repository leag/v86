# 16-bit FPU env/state ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the four stubbed 16-bit x87 environment/state instructions (FLDENV/FSTENV/FRSTOR/FSAVE) faithfully, and fix JIT operand-size dispatch for FLDENV/FSTENV.

**Architecture:** Fill in `fpu_fstenv16` / `fpu_fldenv16` / `fpu_fsave16` / `fpu_frstor16` in `src/rust/cpu/fpu.rs`, mirroring the existing 32-bit functions but using the 14-byte environment image and branching on `*protected_mode` for pointer packing. Fix the two custom JIT handlers (D9/4, D9/6) that hardcode the 32-bit handlers. Verify against real-hardware gdb fixtures via the nasm test harness.

**Tech Stack:** Rust (compiled to wasm), the nasm test harness (`tests/nasm/`), NASM, gdb (golden fixtures generated on the host x86 CPU).

## Global Constraints

- The 16-bit environment image is **14 bytes**; FSAVE/FRSTOR append eight 80-bit registers (total **94 bytes**).
- Pointer packing depends on CPU mode: branch on `*protected_mode`.
- Reuse existing helpers; do not duplicate logic: `fpu_load_status_word() -> u16`, `fpu_load_tag_word() -> i32`, `set_control_word(cw: u16)`, `fpu_set_status_word(sw: u16)`, `fpu_set_tag_word(tag_word: i32)`, `fpu_finit()`, `fpu_store_m80(addr, F80)`, `fpu_load_m80(addr) -> Result<F80,()>`, `writable_or_pagefault(addr, size)`, `readable_or_pagefault(addr, size)`, `safe_write16(addr, value: i32)`, `safe_read16(addr) -> OrPageFault<i32>`.
- `fpu_fstenv16` / `fpu_fldenv16` keep `#[no_mangle]` (called from the JIT by name). `fpu_fsave16` / `fpu_frstor16` stay plain `pub unsafe fn` (matching the 32-bit versions).
- Do NOT touch `fpu_*32`, `gen/jit.rs`, or `instructions.rs` (interpreter dispatch is already correct).
- Build command: `make build/v86-debug.wasm`.
- Single-test cycle:
  ```bash
  ./tests/nasm/create_tests.js
  ./tests/nasm/gen_fixtures.js
  TEST_NAME=<name> ./tests/nasm/run.js
  ```
  (Each requires `build/v86-debug.wasm` to exist; rebuild after Rust changes.)
- 16-bit environment layout (offsets within the 14-byte image):

  Protected mode: `+0` FCW, `+2` FSW, `+4` FTW, `+6` IP offset (low 16), `+8` CS selector, `+10` data offset (low 16), `+12` data selector.

  Real mode: `+0` FCW, `+2` FSW, `+4` FTW, `+6` IP[15:0], `+8` `(IP[19:16]<<12) | (opcode & 0x7FF)`, `+10` DP[15:0], `+12` `(DP[19:16]<<12)`.

---

### Task 1: `fpu_fstenv16`

**Files:**
- Modify: `src/rust/cpu/fpu.rs` (replace the `fpu_fstenv16` stub, currently ~lines 565-569)
- Test: `tests/nasm/fstenv16.asm` (create)

**Interfaces:**
- Consumes: `*fpu_control_word: u16`, `fpu_load_status_word() -> u16`, `fpu_load_tag_word() -> i32`, `*fpu_ip/*fpu_dp/*fpu_opcode: i32`, `*fpu_ip_selector/*fpu_dp_selector: i32`, `*protected_mode: bool`, `writable_or_pagefault`, `safe_write16`, `*page_fault`.
- Produces: `#[no_mangle] pub unsafe fn fpu_fstenv16(addr: i32)` writing the 14-byte env image.

- [ ] **Step 1: Write the failing test**

Create `tests/nasm/fstenv16.asm`:

```asm
global _start

%include "header.inc"

    ; populate a non-trivial FPU state: st1=0 (tag zero), st0=1 (tag valid)
    fldz
    fld1

    o16 fnstenv [esp]

    ; v86 does not faithfully emulate the FPU instruction/data pointer fields,
    ; so zero the non-FCW/FSW/FTW words (+6..+13) before the state is captured;
    ; this compares only FCW (+0), FSW (+2) and FTW (+4) against real hardware.
    mov word [esp + 6], 0
    mov word [esp + 8], 0
    mov word [esp + 10], 0
    mov word [esp + 12], 0

%include "footer.inc"
```

- [ ] **Step 2: Build and run to verify it fails**

```bash
make build/v86-debug.wasm
./tests/nasm/create_tests.js
./tests/nasm/gen_fixtures.js
TEST_NAME=fstenv16 ./tests/nasm/run.js
```
Expected: FAIL — the current `fpu_fstenv16` stub triggers `#UD`, so v86 never writes the image and the memory comparison diverges from the (valid) hardware fixture.

- [ ] **Step 3: Implement `fpu_fstenv16`**

Replace the stub body:

```rust
#[no_mangle]
pub unsafe fn fpu_fstenv16(addr: i32) {
    match writable_or_pagefault(addr, 14) {
        Ok(()) => *page_fault = false,
        Err(()) => {
            *page_fault = true;
            return;
        },
    }
    safe_write16(addr + 0, *fpu_control_word as i32).unwrap();
    safe_write16(addr + 2, fpu_load_status_word() as i32).unwrap();
    safe_write16(addr + 4, fpu_load_tag_word()).unwrap();
    if *protected_mode {
        safe_write16(addr + 6, *fpu_ip & 0xFFFF).unwrap();
        safe_write16(addr + 8, *fpu_ip_selector).unwrap();
        safe_write16(addr + 10, *fpu_dp & 0xFFFF).unwrap();
        safe_write16(addr + 12, *fpu_dp_selector).unwrap();
    }
    else {
        safe_write16(addr + 6, *fpu_ip & 0xFFFF).unwrap();
        safe_write16(addr + 8, (*fpu_ip >> 16 & 0xF) << 12 | (*fpu_opcode & 0x7FF)).unwrap();
        safe_write16(addr + 10, *fpu_dp & 0xFFFF).unwrap();
        safe_write16(addr + 12, (*fpu_dp >> 16 & 0xF) << 12).unwrap();
    }
}
```

- [ ] **Step 4: Rebuild and run to verify it passes**

```bash
make build/v86-debug.wasm
TEST_NAME=fstenv16 ./tests/nasm/run.js
```
Expected: PASS (`fstenv16` reported OK).

- [ ] **Step 5: Commit**

```bash
git add src/rust/cpu/fpu.rs tests/nasm/fstenv16.asm
git commit -m "fpu: implement 16-bit FSTENV (fpu_fstenv16)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `fpu_fldenv16`

**Files:**
- Modify: `src/rust/cpu/fpu.rs` (replace the `fpu_fldenv16` stub, currently ~lines 417-421)
- Test: `tests/nasm/fldenv16.asm` (create)

**Interfaces:**
- Consumes: `readable_or_pagefault`, `safe_read16`, `set_control_word`, `fpu_set_status_word`, `fpu_set_tag_word`, `*fpu_ip/*fpu_dp/*fpu_opcode/*fpu_ip_selector/*fpu_dp_selector`, `*protected_mode`, `*page_fault`. Round-trips with `fpu_fstenv16` from Task 1.
- Produces: `#[no_mangle] pub unsafe fn fpu_fldenv16(addr: i32)` loading the 14-byte env image.

- [ ] **Step 1: Write the failing test**

Create `tests/nasm/fldenv16.asm` (round-trip: save env, wipe FPU, reload env, re-save; compare both images):

```asm
global _start

%include "header.inc"

    ; build a known environment image
    fldz
    fld1
    o16 fnstenv [esp]

    ; wipe FPU state, then reload the saved environment
    fninit
    o16 fldenv [esp]

    ; write the reloaded environment back out for comparison
    o16 fnstenv [esp + 16]

    ; zero un-emulated pointer fields in both images (compare FCW/FSW/FTW only)
    mov word [esp + 6], 0
    mov word [esp + 8], 0
    mov word [esp + 10], 0
    mov word [esp + 12], 0
    mov word [esp + 16 + 6], 0
    mov word [esp + 16 + 8], 0
    mov word [esp + 16 + 10], 0
    mov word [esp + 16 + 12], 0

    ; fldenv restores tags without restoring register data; normalize the live
    ; FPU register/tag state so the final-state register comparison is skipped
    ; (all tags empty) and only the in-memory env images are compared.
    fninit

%include "footer.inc"
```

- [ ] **Step 2: Build and run to verify it fails**

```bash
make build/v86-debug.wasm
./tests/nasm/create_tests.js
./tests/nasm/gen_fixtures.js
TEST_NAME=fldenv16 ./tests/nasm/run.js
```
Expected: FAIL — the current `fpu_fldenv16` stub triggers `#UD`.

- [ ] **Step 3: Implement `fpu_fldenv16`**

Replace the stub body (mirrors `fpu_fldenv32`'s page-fault style):

```rust
#[no_mangle]
pub unsafe fn fpu_fldenv16(addr: i32) {
    if let Err(()) = readable_or_pagefault(addr, 14) {
        *page_fault = true;
        return;
    }
    *page_fault = false;
    set_control_word(safe_read16(addr + 0).unwrap() as u16);
    fpu_set_status_word(safe_read16(addr + 2).unwrap() as u16);
    fpu_set_tag_word(safe_read16(addr + 4).unwrap());
    if *protected_mode {
        *fpu_ip = safe_read16(addr + 6).unwrap();
        *fpu_ip_selector = safe_read16(addr + 8).unwrap();
        *fpu_dp = safe_read16(addr + 10).unwrap();
        *fpu_dp_selector = safe_read16(addr + 12).unwrap();
    }
    else {
        let field8 = safe_read16(addr + 8).unwrap();
        let field12 = safe_read16(addr + 12).unwrap();
        *fpu_ip = safe_read16(addr + 6).unwrap() | (field8 & 0xF000) << 4;
        *fpu_opcode = field8 & 0x7FF;
        *fpu_dp = safe_read16(addr + 10).unwrap() | (field12 & 0xF000) << 4;
    }
}
```

- [ ] **Step 4: Rebuild and run to verify it passes**

```bash
make build/v86-debug.wasm
TEST_NAME=fldenv16 ./tests/nasm/run.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rust/cpu/fpu.rs tests/nasm/fldenv16.asm
git commit -m "fpu: implement 16-bit FLDENV (fpu_fldenv16)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `fpu_fsave16` and `fpu_frstor16`

**Files:**
- Modify: `src/rust/cpu/fpu.rs` (replace the `fpu_frstor16` stub ~lines 528-531 and the `fpu_fsave16` stub ~lines 543-546)
- Test: `tests/nasm/fsave_frstor16.asm` (create)

**Interfaces:**
- Consumes: `fpu_fstenv16`/`fpu_fldenv16` (Tasks 1-2), `fpu_store_m80`, `fpu_load_m80`, `fpu_finit`, `*fpu_stack_ptr: u8`, `*fpu_st: *mut F80`, `writable_or_pagefault`, `readable_or_pagefault`, `return_on_pagefault!`.
- Produces: `pub unsafe fn fpu_fsave16(addr: i32)` and `pub unsafe fn fpu_frstor16(addr: i32)` over the 94-byte image.

- [ ] **Step 1: Write the failing test**

Create `tests/nasm/fsave_frstor16.asm` (modeled on `fsave_frstor.asm`, 16-bit env so registers start at +14):

```asm
global _start

%include "header.inc"

    sub esp, 128
    fldz
    fld1
    o16 fnsave [esp]
    o16 frstor [esp]

    ; zero un-emulated env pointer fields (16-bit layout: +6..+13)
    mov word [esp + 6], 0
    mov word [esp + 8], 0
    mov word [esp + 10], 0
    mov word [esp + 12], 0

%include "footer.inc"
```

- [ ] **Step 2: Build and run to verify it fails**

```bash
make build/v86-debug.wasm
./tests/nasm/create_tests.js
./tests/nasm/gen_fixtures.js
TEST_NAME=fsave_frstor16 ./tests/nasm/run.js
```
Expected: FAIL — both `fpu_fsave16` and `fpu_frstor16` stubs trigger `#UD`.

- [ ] **Step 3: Implement `fpu_fsave16` and `fpu_frstor16`**

Replace the `fpu_frstor16` stub:

```rust
pub unsafe fn fpu_frstor16(mut addr: i32) {
    return_on_pagefault!(readable_or_pagefault(addr, 14 + 8 * 10));
    fpu_fldenv16(addr);
    addr += 14;
    for i in 0..8 {
        let reg_index = *fpu_stack_ptr as i32 + i & 7;
        *fpu_st.offset(reg_index as isize) = fpu_load_m80(addr).unwrap();
        addr += 10;
    }
}
```

Replace the `fpu_fsave16` stub:

```rust
pub unsafe fn fpu_fsave16(mut addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 94));
    fpu_fstenv16(addr);
    addr += 14;
    for i in 0..8 {
        let reg_index = i + *fpu_stack_ptr as i32 & 7;
        fpu_store_m80(addr, *fpu_st.offset(reg_index as isize));
        addr += 10;
    }
    fpu_finit();
}
```

- [ ] **Step 4: Rebuild and run to verify it passes**

```bash
make build/v86-debug.wasm
TEST_NAME=fsave_frstor16 ./tests/nasm/run.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rust/cpu/fpu.rs tests/nasm/fsave_frstor16.asm
git commit -m "fpu: implement 16-bit FSAVE/FRSTOR (fpu_fsave16/fpu_frstor16)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: JIT operand-size dispatch for FLDENV/FSTENV

**Files:**
- Modify: `src/rust/jit_instructions.rs` (the four functions `instr16_D9_4_mem_jit` ~3556, `instr32_D9_4_mem_jit` ~3584, `instr16_D9_6_mem_jit` ~3605, `instr32_D9_6_mem_jit` ~3627)

**Interfaces:**
- Consumes: `fpu_fldenv16`/`fpu_fldenv32`/`fpu_fstenv16`/`fpu_fstenv32` (by name, via `call_fn1`), `codegen::*`, `JitContext`, `ModrmByte`.
- Produces: corrected JIT wrappers; a shared private helper `gen_fldenv_fstenv_jit`.

- [ ] **Step 1: Verify the JIT path currently fails for the 16-bit tests**

```bash
make build/v86-debug.wasm
TEST_NAME='fstenv16|fldenv16' ./tests/nasm/run.js --force-jit
```
Expected: FAIL — the JIT calls `fpu_fstenv32`/`fpu_fldenv32`, emitting the 28-byte 32-bit layout instead of the 14-byte image.

(If the interpreter-mode tests from Tasks 1-2 are not yet present, this task depends on them; run after Tasks 1-2.)

- [ ] **Step 2: Add the shared helper and rewrite the four wrappers**

Replace the existing `instr16_D9_4_mem_jit` / `instr32_D9_4_mem_jit` and `instr16_D9_6_mem_jit` / `instr32_D9_6_mem_jit` definitions. First add the helper immediately before `instr16_D9_4_mem_jit`:

```rust
fn gen_fldenv_fstenv_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, name: &str) {
    codegen::gen_modrm_resolve(ctx, modrm_byte);

    codegen::gen_set_previous_eip_offset_from_eip_with_low_bits(
        ctx.builder,
        ctx.start_of_current_instruction as i32 & 0xFFF,
    );

    codegen::gen_move_registers_from_locals_to_memory(ctx);
    ctx.builder.call_fn1(name);
    codegen::gen_move_registers_from_memory_to_locals(ctx);

    codegen::gen_get_page_fault(ctx.builder);
    ctx.builder.if_void();
    codegen::gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
    ctx.builder.br(ctx.exit_label);
    ctx.builder.block_end();
}
```

Then replace the four mem wrappers (leave the `_reg_jit` functions untouched):

```rust
pub fn instr16_D9_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    gen_fldenv_fstenv_jit(ctx, modrm_byte, "fpu_fldenv16")
}
pub fn instr32_D9_4_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    gen_fldenv_fstenv_jit(ctx, modrm_byte, "fpu_fldenv32")
}
```

```rust
pub fn instr16_D9_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    gen_fldenv_fstenv_jit(ctx, modrm_byte, "fpu_fstenv16")
}
pub fn instr32_D9_6_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte) {
    gen_fldenv_fstenv_jit(ctx, modrm_byte, "fpu_fstenv32")
}
```

- [ ] **Step 3: Rebuild and verify the 16-bit tests pass under JIT**

```bash
make build/v86-debug.wasm
TEST_NAME='fstenv16|fldenv16' ./tests/nasm/run.js --force-jit
```
Expected: PASS.

- [ ] **Step 4: Verify the 32-bit FLDENV/FSTENV tests still pass under JIT (no regression)**

```bash
TEST_NAME='fstenv$|fldenv' ./tests/nasm/run.js --force-jit
```
Expected: PASS (existing `fstenv` test unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/rust/jit_instructions.rs
git commit -m "jit: dispatch FLDENV/FSTENV on operand size (16 vs 32-bit)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Full regression run

**Files:** none (verification only)

- [ ] **Step 1: Run the full nasm suite (interpreter)**

```bash
make build/v86-debug.wasm
./tests/nasm/create_tests.js
./tests/nasm/gen_fixtures.js
./tests/nasm/run.js
```
Expected: all tests pass, including `fstenv16`, `fldenv16`, `fsave_frstor16`.

- [ ] **Step 2: Run the full nasm suite (JIT)**

```bash
./tests/nasm/run.js --force-jit
```
Expected: all tests pass.

- [ ] **Step 3: Confirm no `fpu_unimpl` calls remain for these ops**

```bash
grep -n "fpu_unimpl" src/rust/cpu/fpu.rs
```
Expected: only `fpu_fldenv16`/`fpu_fstenv16`/`fpu_frstor16`/`fpu_fsave16` no longer appear; remaining `fpu_unimpl` references are the definition (~438) and the unrelated `frstor16`→none. (After this work, the only `fpu_unimpl` reference is its own definition.)

---

## Self-Review

**Spec coverage:**
- 16-bit FSTENV → Task 1. 16-bit FLDENV → Task 2. 16-bit FSAVE/FRSTOR → Task 3. Mode-aware layout (real + protected) → Tasks 1-2 (`*protected_mode` branch). JIT dispatch fix (D9/4, D9/6 only) → Task 4. DD/4, DD/6 need no JIT change (spec) → confirmed, no task. Tests on protected-mode 16-bit path against real-hardware fixtures → Tasks 1-3 + Task 5. Real-mode path review-verified (not test-covered) → documented limitation; layout encoded in Tasks 1-2 per the SDM tables.

**Placeholder scan:** No TBD/TODO; all steps include concrete code and commands.

**Type consistency:** `fpu_load_status_word()->u16` (cast to i32 for `safe_write16`), `fpu_load_tag_word()->i32`, `safe_read16->OrPageFault<i32>` (`.unwrap()`), `set_control_word(u16)`/`fpu_set_status_word(u16)` (cast from `safe_read16` i32), `fpu_set_tag_word(i32)`, `fpu_load_m80->Result` (`.unwrap()`), `fpu_store_m80(i32, F80)`. JIT helper signature `(&mut JitContext, ModrmByte, &str)` matches `call_fn1(name)`. Consistent across tasks.
