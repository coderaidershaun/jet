// A real quanty search recorded from Claude Code: the call, what the library gave back, and Jet's answer.
// After it come three hits added by hand, so every kind of source shows, and a search that failed.
export const QUANTY_SEARCH = {
  "use": {
    "id": "toolu_01K3EDj1tq5Co9obfZ2yX4Nx",
    "name": "mcp__quanty__search",
    "input": {
      "question": "What is vega, the sensitivity of an option price to volatility?",
      "limit": 5
    }
  },
  "result": {
    "results": [
      {
        "number": 1,
        "document_id": "c1855664-0f5a-550a-93c0-d6c993e5da1f",
        "document": "Option Volatility & Pricing, chapter 7: Risk Measurement I",
        "media": "Option Volatility & Pricing",
        "category": "book",
        "authors": [
          "Sheldon Natenberg"
        ],
        "media_tags": [
          "options",
          "trading"
        ],
        "tags": [],
        "page": 14,
        "printed_page": "110",
        "kind": "chunk",
        "text": "Just as option values are sensitive to changes in the underlying price (delta) and to the passage of time (theta), they are also sensitive to changes in volatility. This is shown in Figures 7-10 and 7-11. Although the terms *delta*, *gamma*, and *theta* are used by all option traders, there is no one generally accepted term for the sensitivity of an option's theoretical value to a change in volatility. The most commonly used term in the trading community is *vega*, and this is the term that will be used in this text. But this is by no means universal. Because vega is not a Greek letter, a common alternative in academic literature, where Greek letters are preferred, is *kappa* (K).[^9]\n\n[^9]: Traders tend to prefer the term vega because it starts with a v and is therefore a convenient reminder that it is associated with volatility. Vega is sometimes abbreviated with the Greek letter nu (v) because in written form it is similar to a \\(\\nu\\).\n\nThe vega of an option is usually expressed as the change in theoretical value for each one percentage point change in volatility. Because all options gain value with rising volatility, the vega for both calls and puts is positive. If an option has a vega of 0.15, for each percentage point increase (decrease) in volatility, the option will gain (lose) 0.15 in theoretical value. If the option has a theoretical value of 3.25 at a volatility of 20 percent, then it will have a theoretical value of 3.40 at a volatility of 21 percent and a theoretical value of 3.10 at a volatility of 19 percent.",
        "score": 0.8491207957267761,
        "reason": {
          "why": "nearest"
        }
      },
      {
        "number": 2,
        "document_id": "9d47f91b-db5f-55ac-ab8e-6babf8089573",
        "document": "Option Volatility & Pricing, chapter 9: Risk Measurement II",
        "media": "Option Volatility & Pricing",
        "category": "book",
        "authors": [
          "Sheldon Natenberg"
        ],
        "media_tags": [
          "options",
          "trading"
        ],
        "tags": [],
        "page": 9,
        "printed_page": "145",
        "kind": "chunk",
        "text": "Figure 9-12 shows the vega of an option as we change the underlying price. Note that this figure is almost identical to Figure 9-8. As with the theta, the vega is greatest when an option is at the money, and an at-the-money option with a higher exercise price has a greater vega than an at-the-money option with a lower exercise price. Moreover, the vega of an at-the-money option is proportional to its exercise price. Assuming that all other conditions are the same, an at-the-money option with an exercise price of 100 will have a vega that is twice that of an option with an exercise price of 50. Note that the term *vanna*, which previously referred to the sensitivity of delta to a change in volatility, can also refer to the sensitivity of the vega to a change in the underlying price. Both interpretations are mathematically identical.\n\nFigure 9-13 shows the theoretical value of an in-the-money, at-the-money, and out-of-the-money option as we change volatility. Of particular note is the fact that the value of an at-the-money option is essentially a straight line. Because the vega is the slope of the graph, we can conclude that the vega of an at-the-money option is relatively constant with respect to changes in volatility. Whether volatility is 20 percent, 30 percent, or some higher value, the vega of an at-the-money option will be the same.",
        "score": 0.805045485496521,
        "reason": {
          "why": "nearest"
        }
      },
      {
        "number": 3,
        "document_id": "9d47f91b-db5f-55ac-ab8e-6babf8089573",
        "document": "Option Volatility & Pricing, chapter 9: Risk Measurement II",
        "media": "Option Volatility & Pricing",
        "category": "book",
        "authors": [
          "Sheldon Natenberg"
        ],
        "media_tags": [
          "options",
          "trading"
        ],
        "tags": [],
        "page": 10,
        "printed_page": "146",
        "kind": "chunk",
        "text": "The effect on the vega of changing volatility is shown in Figure 9-14. While the vega of the at-the-money option is relatively constant, the vega values of in-the-money and out-of-the-money options tend to rise with higher volatility.[^5] This is logical when we recall that as we raise volatility, the deltas of in-the-money and out-of-the-money options tend toward 50, causing the options to act more and more as if they are at the money. Because at-the-money options have the greatest vega (see Figure 9-12), we would expect the\n\n[^5]: In fact, we can see from Figure 9-14 that the vega of an at-the-money option declines very slightly as we raise volatility. This will be discussed in greater detail in Chapter 18.\n\nvega values to rise. The sensitivity of vega to a change in volatility is sometimes referred to as either the *volga* or the *vomma* (both terms are a contraction of volatility and gamma—either *vo*latility *gamma* or *vo*latility *gamma*).\n\nFigure 9-15 shows volga values for calls and puts with varying deltas. We have already noted that an at-the-money option with a delta of approximately 50 has a relatively constant vega and, consequently, a volga close to 0. However, as an option moves either into the money or out of the money, the volga begins to increase, reaching its maximum for calls with deltas of approximately 10 and 90 and puts with deltas of approximately -10 and -90. Additionally, as we increase time, volga values for in-the-money and out-of-the-money options become more sensitive to the passage of time, with long-term options having greater volga values than short-term options.\n\nIn Figure 9-16, we can see how vega values change as time changes, rising as we increase time to expiration and falling as we reduce time. This characteristic, that long-term options are always more sensitive to changes in volatility than short-term options, was introduced in Chapter 6 (see Figures 6-11 and 6-12).",
        "score": 0.7991361618041992,
        "reason": {
          "why": "nearest"
        }
      },
      {
        "number": 4,
        "document_id": "abbfc870-9746-50d3-95f8-50d53cc9a9e7",
        "document": "Option Volatility & Pricing, chapter 18: The Black Scholes Model",
        "media": "Option Volatility & Pricing",
        "category": "book",
        "authors": [
          "Sheldon Natenberg"
        ],
        "media_tags": [
          "options",
          "trading"
        ],
        "tags": [],
        "page": 12,
        "printed_page": "350",
        "kind": "chunk",
        "text": "The vega and rho formulas give the sensitivity of the option to a one full point (100%) change in volatility (the vega) or interest rates (rho). To express vega and rho values in the more common form of a one percentage point change in volatility or interest rates the vega and rho must be divided by 100.",
        "score": 0.7986910343170166,
        "reason": {
          "why": "nearest"
        }
      },
      {
        "number": 5,
        "document_id": "c1855664-0f5a-550a-93c0-d6c993e5da1f",
        "document": "Option Volatility & Pricing, chapter 7: Risk Measurement I",
        "media": "Option Volatility & Pricing",
        "category": "book",
        "authors": [
          "Sheldon Natenberg"
        ],
        "media_tags": [
          "options",
          "trading"
        ],
        "tags": [],
        "page": 20,
        "printed_page": "116",
        "kind": "chunk",
        "text": "The vega of Position 1 is -1.70. This indicates a desire for declining volatility. For each point decline in volatility, the value of our position, which was initially +2.20, will increase by 1.70; for each point increase, the value will fall by 1.70. This seems to correspond to our gamma risk. If we have a negative gamma, we want the market to remain relatively quiet. Isn't this the same as saying we want lower volatility? Most traders, however, make an important distinction between the gamma and vega. The gamma is a measure of whether we want higher or lower *realized* volatility (whether we want the underlying contract to be more volatile or less volatile). The vega is a measure of whether we want higher or lower *implied* volatility. Although the volatility of the underlying contract and changes in implied volatility are often correlated, this is not always the case. In some cases, the underlying contract can become more volatile while implied volatility is falling. In other cases, the underlying contract can become less volatile while implied volatility is rising. We will look at the conditions that can cause this in Chapter 11, where we look at some of the common volatility spreads.\n\nSuppose that we raise the volatility of 25 percent in Figure 7-13 to a volatility of 26 percent. What should be our theoretical profit now? We know that for each point increase in volatility, we need to add the vega (-1.70) to the old value (+2.20) to get the new value. Our theoretical profit at 26 percent will be\n\nIf we raise the volatility another percentage point to 27 percent, our theoretical edge turns negative\n\nWe can see that the position has a *breakeven* volatility of approximately",
        "score": 0.7937067747116089,
        "reason": {
          "why": "nearest"
        }
      }
    ],
    "usage": [
      {
        "model": "gemini-embedding-2",
        "input_tokens": 23,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "estimated": true
      }
    ],
    "cost_usd": 0.000004600000000000001
  },
  "reply": "Vega is how much an option's theoretical value changes when implied volatility moves by one percentage point. Calls and puts both have positive vega, because higher volatility makes any option worth more [1]. For example, with a vega of 0.15, an option worth 3.25 at 20% volatility becomes worth about 3.40 at 21% [1].\n\n- **Where it's largest:** at-the-money options. It also grows with time to expiry, so long-dated options are more sensitive to volatility than short-dated ones [2][3].\n- **Vega and gamma:** gamma tells you whether you want more or less *realized* volatility. Vega tells you whether you want more or less *implied* volatility. The two usually move together, but not always [5].\n- **Units:** the textbook formula gives the change for a full 100% move in volatility. Divide by 100 to get the usual \"per point\" figure [4].\n- **Name:** vega isn't a Greek letter. Academics sometimes call it kappa [1].\n\nIf you want, I can go on to volga/vomma, which is how vega itself changes as volatility moves."
};

// Three more hits, added by hand with their text copied from the library's own files, so a formula, a table and a figure show as well as chunks.
export const ADDED_HITS = [
  {
    "number": 6,
    "document_id": "abbfc870-9746-50d3-95f8-50d53cc9a9e7",
    "document": "Option Volatility & Pricing, chapter 18: The Black Scholes Model",
    "media": "Option Volatility & Pricing",
    "category": "book",
    "authors": [
      "Sheldon Natenberg"
    ],
    "media_tags": [
      "options",
      "trading"
    ],
    "tags": [],
    "page": 12,
    "printed_page": "350",
    "kind": "formula",
    "text": "C = S e^{(b-r)t} N(d_1) - X e^{-rt} N(d_2)",
    "score": 0.7712,
    "reason": {
      "why": "concept",
      "concept": "Black-Scholes model"
    }
  },
  {
    "number": 7,
    "document_id": "abbfc870-9746-50d3-95f8-50d53cc9a9e7",
    "document": "Option Volatility & Pricing, chapter 18: The Black Scholes Model",
    "media": "Option Volatility & Pricing",
    "category": "book",
    "authors": [
      "Sheldon Natenberg"
    ],
    "media_tags": [
      "options",
      "trading"
    ],
    "tags": [],
    "page": 12,
    "printed_page": "350",
    "kind": "table",
    "label": "Figure 18-6",
    "text": "| | Call | Put |\n|---|---|---|\n| Delta (Δ) | \\(e^{(b-r)t} N(d_1)\\) | \\(e^{(b-r)t} [N(d_1)-1]\\) |\n| Gamma (Γ) | \\(\\frac{e^{(b-r)t} n(d_1)}{S\\sigma\\sqrt{t}}\\) (same for calls and puts) | \\(\\frac{e^{(b-r)t} n(d_1)}{S\\sigma\\sqrt{t}}\\) |\n| Theta (Θ)* | \\(\\frac{-S e^{(b-r)t} n(d_1)\\sigma}{2\\sqrt{t}} + (b-r)S e^{(b-r)t} N(d_1) - rX e^{-rt} N(d_2)\\) | \\(\\frac{-S e^{(b-r)t} n(d_1)\\sigma}{2\\sqrt{t}} + (b-r)S e^{(b-r)t} N(d_1) + rX e^{-rt} N(-d_2)\\) |\n| Vega** | \\(S e^{(b-r)t} n(d_1)\\sqrt{t}\\) (same for calls and puts) | \\(S e^{(b-r)t} n(d_1)\\sqrt{t}\\) |\n| Rho (P)** | \\(tXe^{-rt} N(d_2)\\) if b ≠ 0; -tC if b = 0 | \\(-tXe^{-rt} N(-d_2)\\) if b ≠ 0; -tP if b = 0 |\n| Rho\\(_f\\) or Phi (Φ) | \\(-tS e^{(b-r)t} N(d_1)\\) | \\(tS e^{(b-r)t} N(-d_1)\\) |\n| Elasticity (Λ) | \\(\\Delta_C (S/C)\\) | \\(\\Delta_P (S/P)\\) |",
    "score": 0.765,
    "reason": {
      "why": "cited",
      "by": 4,
      "label": "Figure 18-6"
    }
  },
  {
    "number": 8,
    "document_id": "c1855664-0f5a-550a-93c0-d6c993e5da1f",
    "document": "Option Volatility & Pricing, chapter 7: Risk Measurement I",
    "media": "Option Volatility & Pricing",
    "category": "book",
    "authors": [
      "Sheldon Natenberg"
    ],
    "media_tags": [
      "options",
      "trading"
    ],
    "tags": [],
    "page": 15,
    "printed_page": "111",
    "kind": "figure",
    "label": "Figure 7-10",
    "text": "Figure 7-10 Theoretical value of a call with changing volatility. A line chart with 'Call option value' on the vertical axis and underlying price on the horizontal axis, running from 'Lower underlying prices' on the left to 'Higher underlying prices' on the right.\n\nA vertical dotted line marks the 'Exercise price'. The 'Lower volatility' curve is solid, flat near zero at low prices and rising convexly to the upper right. The 'Higher volatility' curve is dotted and lies above the solid curve everywhere, converging with it at the top right. The 'Intrinsic value' is a dashed line, zero until the exercise price and then rising linearly to the upper right.\n\nThe figure shows that a call's theoretical value is higher with higher volatility, with the gap largest near the exercise price, and that both values lie above intrinsic value.\n\nText printed in the figure: \"Call option value\"; \"Exercise price\"; \"Lower volatility\"; \"Higher volatility\"; \"Intrinsic value\"; \"Lower underlying prices\"; \"Higher underlying prices\"",
    "picture": "content/option-volatility-pricing/chapter-7/page-num-15/01-figure.png",
    "score": 0.759,
    "reason": {
      "why": "cited",
      "by": 1,
      "label": "Figure 7-10"
    }
  }
];

// A search that failed because the library was down, and the reply Jet gives.
export const QUANTY_DOWN = {
  "use": {
    "id": "toolu_quanty_down_01",
    "name": "mcp__quanty__search",
    "input": {
      "question": "What is vega, the sensitivity of an option price to volatility?",
      "limit": 5
    }
  },
  "result": "could not connect to the graph: FalkorDB at 127.0.0.1:6379 refused the connection. Call the `health` tool to see which service is not ready.",
  "reply": "I couldn't reach the library just now: quanty says it cannot connect to its graph store, so I can't cite the books. From memory, vega is how much an option's value changes when implied volatility moves by one percentage point. Ask me to check the library's health and I'll find which service is down."
};
