import { Type } from "class-transformer";
import {
  IsDefined,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from "class-validator";

export class PayerIdentificationDto {
  @IsString()
  @IsNotEmpty()
  type!: string;

  @IsString()
  @IsNotEmpty()
  number!: string;
}

export class PaymentPayerDto {
  @IsEmail()
  email!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => PayerIdentificationDto)
  identification!: PayerIdentificationDto;
}

export class CreatePaymentDto {
  @IsUUID()
  attemptId!: string;

  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsString()
  @IsNotEmpty()
  paymentMethodId!: string;

  @IsOptional()
  @IsString()
  issuerId?: string;

  @IsInt()
  @Min(1)
  installments!: number;

  @IsDefined()
  @ValidateNested()
  @Type(() => PaymentPayerDto)
  payer!: PaymentPayerDto;
}
