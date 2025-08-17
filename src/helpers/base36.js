import { base16ToBytes, bytesToBase16 } from '#helpers/base16.js'

export const BASE36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const BASE = BigInt(BASE36_ALPHABET.length)
const LEADER = BASE36_ALPHABET[0]
const CHAR_MAP = new Map([...BASE36_ALPHABET].map((char, index) => [char, BigInt(index)]))

export function bytesToBase36 (bytes, padLength = 0) {
  return base16ToBase36(bytesToBase16(bytes), padLength)
}

export function base16ToBase36 (string, padLength) {
  return bigIntToBase36(base16ToBigInt(string), padLength)
}

export function base36ToBytes (string) {
  return base16ToBytes(base36ToBase16(string))
}

export function base36ToBase16 (string) {
  return bigIntToBase16(base36ToBigInt(string))
}

function base36ToBigInt (string) {
  if (typeof string !== 'string') {
    throw new Error('Input must be a string.')
  }

  let result = 0n
  for (const char of string) {
    const value = CHAR_MAP.get(char)
    if (value === undefined) {
      throw new Error(`Invalid character in Base36 string: ${char}`)
    }
    result = result * BASE + value
  }
  return result
}

function bigIntToBase36 (num, padLength) {
  if (typeof num !== 'bigint') throw new Error('Input must be a BigInt.')
  if (num < 0n) throw new Error('Can\'t be signed BigInt')

  num.toString(36).padStart(padLength, LEADER)
}

function bigIntToBase16 (num) {
  if (typeof num !== 'bigint') throw new Error('Input must be a BigInt.')
  if (num < 0n) throw new Error('Can\'t be signed BigInt')

  let hexString = num.toString(16)
  if (hexString.length % 2 !== 0) hexString = `0${hexString}`
  return hexString
}

function base16ToBigInt (hex) {
  if (typeof hex !== 'string') throw new Error('Input must be a string.')
  return BigInt(`0x${hex}`)
}
