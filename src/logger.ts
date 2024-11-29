import winston, { format, transports } from "winston";

import type { Logform } from "winston";

export const setupLogger = (environment: string | undefined, logLevel: string | undefined) => {
  const isProduction = environment === "production";

  const loggerFormatters: Logform.Format[] = isProduction
    ? [format.timestamp(), format.ms(), format.json()]
    : [
        format.timestamp({
          format: "DD/MM/YYYY HH:mm:ss.SSS",
        }),
        format.colorize(),
        format.simple(), // ? format.json() :
      ];

  const defaultLogLevel = isProduction ? "info" : "debug";

  winston.configure({
    level: logLevel || defaultLogLevel,
    transports: [
      new transports.Console({
        format: format.combine(...loggerFormatters),
        handleExceptions: true,
      }),
    ],
  });
};
