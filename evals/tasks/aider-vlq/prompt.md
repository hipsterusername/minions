# JavaScript variable-length-quantity

Export encode(numbers) and decode(bytes) from variable-length-quantity.mjs.
Both take arrays and return arrays. Encode unsigned integers 0 through 0xffffffff
as minimal, most-significant-group-first VLQs; concatenate multiple encodings.
Decode concatenated VLQs into unsigned numbers in order, including values above
0x7fffffff. A trailing continuation byte must throw Error with message
`Incomplete sequence`, even when its payload is zero. Inputs are within the
stated unsigned 32-bit/byte domain; no other invalid-input behavior is required.

Use Node built-ins only; implement the named module. You may create local checks.
Do not use the internet or consult solutions outside this workspace.
For graph mode, use Codex with model gpt-5.6-sol for every child agent.

# Instructions

Implement variable length quantity encoding and decoding.

The goal of this exercise is to implement [VLQ][vlq] encoding/decoding.

In short, the goal of this encoding is to encode integer values in a way that would save bytes.
Only the first 7 bits of each byte are significant (right-justified; sort of like an ASCII byte).
So, if you have a 32-bit value, you have to unpack it into a series of 7-bit bytes.
Of course, you will have a variable number of bytes depending upon your integer.
To indicate which is the last byte of the series, you leave bit #7 clear.
In all of the preceding bytes, you set bit #7.

So, if an integer is between `0-127`, it can be represented as one byte.
Although VLQ can deal with numbers of arbitrary sizes, for this exercise we will restrict ourselves to only numbers that fit in a 32-bit unsigned integer.
Here are examples of integers as 32-bit values, and the variable length quantities that they translate to:

```text
 NUMBER        VARIABLE QUANTITY
00000000              00
00000040              40
0000007F              7F
00000080             81 00
00002000             C0 00
00003FFF             FF 7F
00004000           81 80 00
00100000           C0 80 00
001FFFFF           FF FF 7F
00200000          81 80 80 00
08000000          C0 80 80 00
0FFFFFFF          FF FF FF 7F
```

[vlq]: https://en.wikipedia.org/wiki/Variable-length_quantity
