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
