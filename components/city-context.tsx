"use client";

import { createContext, useContext } from "react";
import { type City, DEFAULT_CITY } from "../src/cities";

// Registry `render()` takes no arguments, so layers get the active city from context, not a prop.
const CityContext = createContext<City>(DEFAULT_CITY);

export const CityProvider = CityContext.Provider;

export function useCity(): City {
  return useContext(CityContext);
}
