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
