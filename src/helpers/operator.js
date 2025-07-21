// https://stackoverflow.com/a/13356338
export const typeof2 = variable => Object.prototype.toString.call(variable).slice(8, -1).toLowerCase()
