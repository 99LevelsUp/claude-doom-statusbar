// A warning in the form the warning line under the bar takes (src/kit/skin/warnings.js). The same
// cause in the same place must give the same key on every render: the key is what the store
// remembers.
export const makeWarning = ({ key, cause, skin = null, element = null, subject, message }) =>
  Object.freeze({ key, cause, skin, element, subject, message });
