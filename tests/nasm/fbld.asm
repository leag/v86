global _start

%include "header.inc"

    ; Test 1: positive value 1234567890
    ; BCD bytes (low addr first): 90 78 56 34 12 00 00 00 00 00
    mov dword [esp], 0x34567890
    mov dword [esp + 4], 0x00000012
    mov word  [esp + 8], 0x0000
    fbld [esp]

    ; Test 2: negative value -9876543210
    ; BCD bytes (low addr first): 10 32 54 76 98 00 00 00 00 80
    mov dword [esp], 0x76543210
    mov dword [esp + 4], 0x00000098
    mov word  [esp + 8], 0x8000
    fbld [esp]

    ; Test 3: zero (positive sign byte)
    mov dword [esp], 0x00000000
    mov dword [esp + 4], 0x00000000
    mov word  [esp + 8], 0x0000
    fbld [esp]

    ; Test 4: largest 18-digit value 999999999999999999
    mov dword [esp], 0x99999999
    mov dword [esp + 4], 0x99999999
    mov word  [esp + 8], 0x0099
    fbld [esp]

    ; Test 5: negative largest 18-digit value
    mov dword [esp], 0x99999999
    mov dword [esp + 4], 0x99999999
    mov word  [esp + 8], 0x8099
    fbld [esp]

    ; Test 6: non-BCD nibbles (A-F). Per Intel the result is undefined,
    ; but v86 currently treats each nibble as its hex value (0-15).
    ; Bytes (low addr first): AB CD EF 00 00 00 00 00 00 00
    mov dword [esp], 0x00EFCDAB
    mov dword [esp + 4], 0x00000000
    mov word  [esp + 8], 0x0000
    fbld [esp]

    ; Test 7: sign byte with non-sign bits set. Per Intel only bit 7 of the
    ; sign byte is meaningful; bits 0-6 are don't-care. Value = 42, sign
    ; byte = 0x7F (positive, all low bits set as garbage).
    mov dword [esp], 0x00000042
    mov dword [esp + 4], 0x00000000
    mov word  [esp + 8], 0x7F00
    fbld [esp]

%include "footer.inc"
