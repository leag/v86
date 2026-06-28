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
