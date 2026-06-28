#!/usr/bin/env node

// Differential fuzzer for the x87 environment/state instructions:
//   FLDENV / FSTENV / FRSTOR / FSAVE, in both 16-bit (o16) and 32-bit forms.
//
// It emits randomized `fuzz_fpuenv_*.asm` programs into this directory. The
// existing nasm harness then assembles them, captures golden CPU/FPU/memory
// state from a real x86 host under gdb (gen_fixtures.js), runs the same binary
// in v86's wasm, and diffs (run.js). A divergence is a bug in the emulator.
//
// The interesting axis this exercises that the hand-written tests do not:
//   * randomized FPU stack depth / tag word / TOP pointer,
//   * the operand image deliberately straddling a page boundary (0x101000),
//     which drives the split-page write/read paths and the
//     writable/readable_or_pagefault precheck invariant the store/load ops
//     rely on for memory safety.
//
// Usage:
//   ./gen-fpu-env-fuzz.js [--count N] [--seed S]
//   ./create_tests.js && ./gen_fixtures.js && TEST_NAME=fuzz_fpuenv ./run.js
//
// Only exact FP values (0, +/-1, small integers) are pushed, so the saved
// 80-bit register payloads and the status word match x87 bit-for-bit and the
// fuzzer does not produce false positives from softfloat rounding. Fields v86
// does not emulate (FPU IP/CS/opcode/DP and the un-implemented FSW exception
// bits) are normalized identically in both runs before comparison.

import fs from "node:fs";
import url from "node:url";
import Rand from "./rand.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

// bss is linked at 0x100000, stack_top (esp) at 0x102000; the whole
// [0x100000, 0x102000) window is compared against the golden state. There is a
// page boundary at 0x101000 inside this window.
const PAGE_BOUNDARY = 0x101000;
// Keep buffers well below esp (~0x101FE0) so the build-state `push`es and the
// image writes never collide.
const LOW_SLOT = 0x100200;

// FSW bits v86 does not faithfully implement (matches FPU_STATUS_MASK in
// run.js): DE(1), OE(3), PE(5), C1(9). Cleared in the stored image in both runs.
const FSW_UNEMULATED_MASK = (1 << 1) | (1 << 3) | (1 << 5) | (1 << 9); // 0x022A

function parse_args()
{
    let count = 200;
    let seed = 0x1d3a7b9c;
    const argv = process.argv.slice(2);
    for(let i = 0; i < argv.length; i++)
    {
        if(argv[i] === "--count") count = +argv[++i];
        else if(argv[i] === "--seed") seed = +argv[++i];
        else throw new Error("Unknown argument: " + argv[i]);
    }
    return { count, seed };
}

function hex(n)
{
    return "0x" + (n >>> 0).toString(16);
}

// Layout of the environment image for the two operand sizes.
function env_layout(size16)
{
    if(size16)
    {
        return {
            env_bytes: 14,
            fsw_off: 2,
            // words that are un-emulated pointer fields (zeroed before compare)
            zero_words: [6, 8, 10, 12],
            regs_off: 14,
        };
    }
    return {
        env_bytes: 28,
        fsw_off: 4,
        // high halves of fcw/fsw/ftw dwords + all pointer dwords
        zero_words: [2, 6, 10, 12, 14, 16, 18, 20, 22, 24, 26],
        regs_off: 28,
    };
}

// Random sequence that varies FPU stack depth, TOP pointer and tag word using
// only well-defined pushes of exact values onto free slots. Deliberately avoids
// fincstp/fdecstp: rotating TOP over an occupied slot turns a later fld into an
// x87 stack-overflow (indefinite-NaN + special tag), a divergence in fld/stack-
// fault handling that is upstream of the env/state ops under test and would be
// noise here. Each push targets a fresh slot, so depth stays in 0..7 and no
// exception/condition-code state is touched.
function build_state(rng)
{
    const lines = [];
    const depth = rng.uint32() % 8; // 0..7 pushes, never overflows the 8 slots
    for(let i = 0; i < depth; i++)
    {
        const pick = rng.uint32() % 3;
        if(pick === 0) { lines.push("    fld1"); }
        else if(pick === 1) { lines.push("    fldz"); }
        else
        {
            // fild of a small exact integer (0..199)
            const v = rng.uint32() % 200;
            lines.push("    push dword " + v);
            lines.push("    fild dword [esp]");
            lines.push("    add esp, 4");
        }
    }
    return lines;
}

// Pick the address of the active image buffer. Either deliberately straddling
// the 0x101000 page boundary, or aligned / unaligned within a single page.
function pick_addr(rng, image_size)
{
    const mode = rng.uint32() % 3;
    if(mode === 0)
    {
        // straddle: start a few bytes before the boundary so the image crosses
        const off = 2 + (rng.uint32() % (image_size - 2));
        return { addr: PAGE_BOUNDARY - off, mode: "straddle" };
    }
    if(mode === 1)
    {
        return { addr: LOW_SLOT, mode: "aligned" };
    }
    return { addr: LOW_SLOT + 1 + (rng.uint32() % 7), mode: "unaligned" };
}

// Emit the normalization of un-emulated fields in the stored image at `base`.
function normalize_image(base, lay)
{
    const lines = [];
    lines.push("    ; mask FSW bits v86 does not implement (matches run.js)");
    lines.push("    and word [" + hex(base + lay.fsw_off) + "], " +
               hex(0xFFFF & ~FSW_UNEMULATED_MASK));
    lines.push("    ; zero un-emulated FPU IP/CS/opcode/DP (and dword high halves)");
    for(const w of lay.zero_words)
    {
        lines.push("    mov word [" + hex(base + w) + "], 0");
    }
    return lines;
}

function make_test(rng)
{
    const size16 = (rng.uint32() & 1) === 0;
    const variant = rng.uint32() % 4; // 0 fnstenv, 1 fnsave, 2 fldenv rt, 3 frstor rt
    const lay = env_layout(size16);
    const has_regs = (variant === 1 || variant === 3);
    const image_size = has_regs ? lay.regs_off + 80 : lay.env_bytes;
    const pfx = size16 ? "o16 " : "";

    const placement = pick_addr(rng, image_size);
    const base = placement.addr;

    const out = [];
    out.push("; AUTO-GENERATED by gen-fpu-env-fuzz.js -- do not edit, do not commit");
    out.push("; variant=" + ["fnstenv", "fnsave", "fldenv-roundtrip", "frstor-roundtrip"][variant] +
             " opsize=" + (size16 ? 16 : 32) +
             " placement=" + placement.mode + " base=" + hex(base) + " image_size=" + image_size);
    out.push("global _start");
    out.push("");
    out.push('%include "header.inc"');
    out.push("");

    out.push(...build_state(rng));
    out.push("");

    if(variant === 0)
    {
        out.push("    " + pfx + "fnstenv [" + hex(base) + "]");
    }
    else if(variant === 1)
    {
        out.push("    " + pfx + "fnsave [" + hex(base) + "]");
    }
    else
    {
        // in-place round trip: save, wipe, reload, re-save, then compare
        const op_store = variant === 3 ? "fnsave" : "fnstenv";
        const op_load = variant === 3 ? "frstor" : "fldenv";
        out.push("    " + pfx + op_store + " [" + hex(base) + "]");
        out.push("    fninit");
        out.push("    " + pfx + op_load + " [" + hex(base) + "]");
        out.push("    " + pfx + op_store + " [" + hex(base) + "]");
    }
    out.push("");

    out.push(...normalize_image(base, lay));
    out.push("");

    // normalize live FPU register/tag state so the final-state register
    // comparison is trivially equal; the signal is the in-memory image.
    out.push("    fninit");
    out.push("");
    out.push('%include "footer.inc"');
    out.push("");
    return out.join("\n");
}

function main()
{
    const { count, seed } = parse_args();

    // remove stale generated tests so a smaller --count does not leave orphans
    for(const f of fs.readdirSync(__dirname))
    {
        if(/^fuzz_fpuenv_.*\.asm$/.test(f)) fs.unlinkSync(__dirname + "/" + f);
    }

    const rng = new Rand(seed);
    for(let i = 0; i < count; i++)
    {
        const name = "fuzz_fpuenv_" + seed.toString(16) + "_" + String(i).padStart(4, "0") + ".asm";
        fs.writeFileSync(__dirname + "/" + name, make_test(rng));
    }
    console.log("Generated " + count + " tests (seed " + hex(seed) + ") in " + __dirname);
    console.log("Run: ./create_tests.js && ./gen_fixtures.js && TEST_NAME=fuzz_fpuenv ./run.js");
}

main();
