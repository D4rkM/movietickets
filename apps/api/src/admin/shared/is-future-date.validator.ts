import { registerDecorator, ValidationOptions } from "class-validator";

/** True when the value parses as a date strictly after "now". */
export function isFutureDate(value: unknown, now: Date = new Date()): boolean {
  if (typeof value !== "string" && !(value instanceof Date)) return false;
  const time = new Date(value).getTime();
  return !Number.isNaN(time) && time > now.getTime();
}

export function IsFutureDate(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: "isFutureDate",
      target: object.constructor,
      propertyName,
      options: { message: `${propertyName} precisa ser uma data futura`, ...validationOptions },
      validator: { validate: (value: unknown) => isFutureDate(value) },
    });
  };
}
